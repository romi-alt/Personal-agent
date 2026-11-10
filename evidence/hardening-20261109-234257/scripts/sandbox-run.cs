// ELEVARIQ V2.1 isolation prototype: run a command inside a Windows AppContainer + job object.
// Build (no admin): %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /out:sandbox-run.exe sandbox-run.cs
//
// Usage: sandbox-run.exe --name <container> [--net] [--mem-mb N] [--rw DIR]... [--rx DIR]... [--cwd DIR] -- <exe> [args...]
//
// Properties this prototype relies on (all OS-enforced, none by text filtering):
//  * AppContainer token: every object access needs a grant to the container SID (or ALL APPLICATION PACKAGES) IN
//    ADDITION to the user's normal DACL check. User-profile, %LOCALAPPDATA%, and E:\ grant neither, so they are denied.
//  * Without the internetClient capability (S-1-15-3-1) the process has no outbound network; loopback is blocked for
//    AppContainers by default.
//  * The token is inherited by every child process (scripts, shells, interpreters), so a generated script, an
//    environment-variable change or an indirect launcher cannot leave the boundary.
//  * Job object: kill-on-close (no orphaned worker trees) and an optional hard job-wide commit limit.
// Nothing here needs administrator rights. The profile is per-user and removable with --delete-profile.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

static class SandboxRun
{
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint capCount, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeleteAppContainerProfile(string name);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int GetAppContainerFolderPath(string sidString, out IntPtr path);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr t);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len, IntPtr ret);

    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000, CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400;
    const int PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    const uint JOB_KILL_ON_CLOSE = 0x2000, JOB_MEMORY = 0x200;
    const int ERROR_ALREADY_EXISTS_HR = unchecked((int)0x800700B7);

    static int Fail(string m) { Console.Error.WriteLine("sandbox-run: " + m); return 125; }

    static string Quote(string a) {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        var sb = new StringBuilder("\"");
        int bs = 0;
        foreach (char c in a) {
            if (c == '\\') { bs++; continue; }
            if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
            sb.Append('\\', bs); bs = 0; sb.Append(c);
        }
        sb.Append('\\', bs * 2); sb.Append('"');
        return sb.ToString();
    }

    static void Grant(string dir, SecurityIdentifier sid, FileSystemRights rights) {
        var di = new DirectoryInfo(dir);
        var acl = di.GetAccessControl();
        acl.AddAccessRule(new FileSystemAccessRule(sid, rights,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        di.SetAccessControl(acl);
    }

    static int Main(string[] argv)
    {
        string name = null; bool net = false; long memMb = 0; uint timeoutMs = 0xFFFFFFFF; string cwd = null; bool del = false, printSid = false;
        var rw = new List<string>(); var rx = new List<string>(); var rxFiles = new List<string>();
        int i = 0;
        for (; i < argv.Length; i++) {
            string a = argv[i];
            if (a == "--") { i++; break; }
            else if (a == "--name") name = argv[++i];
            else if (a == "--net") net = true;
            else if (a == "--mem-mb") memMb = long.Parse(argv[++i]);
            else if (a == "--timeout-sec") timeoutMs = uint.Parse(argv[++i]) * 1000;
            else if (a == "--rw") rw.Add(argv[++i]);
            else if (a == "--rx") rx.Add(argv[++i]);
            else if (a == "--rx-file") rxFiles.Add(argv[++i]);
            else if (a == "--cwd") cwd = argv[++i];
            else if (a == "--delete-profile") del = true;
            else if (a == "--print-sid") printSid = true;
            else return Fail("unknown option " + a);
        }
        if (name == null) return Fail("--name required");
        if (del) { int h = DeleteAppContainerProfile(name); Console.WriteLine("deleted hr=0x" + h.ToString("X8")); return h == 0 ? 0 : 1; }

        IntPtr sid;
        int hr = CreateAppContainerProfile(name, name, "ELEVARIQ worker isolation prototype", IntPtr.Zero, 0, out sid);
        if (hr == ERROR_ALREADY_EXISTS_HR) hr = DeriveAppContainerSidFromAppContainerName(name, out sid);
        if (hr != 0) return Fail("AppContainer profile failed hr=0x" + hr.ToString("X8"));
        IntPtr sidStrPtr; ConvertSidToStringSid(sid, out sidStrPtr);
        string sidStr = Marshal.PtrToStringUni(sidStrPtr);
        var secSid = new SecurityIdentifier(sidStr);
        if (printSid) { Console.WriteLine(sidStr); return 0; }
        IntPtr folderPtr; string folder = null;
        if (GetAppContainerFolderPath(sidStr, out folderPtr) == 0) folder = Marshal.PtrToStringUni(folderPtr);

        try {
            foreach (var d in rw) Grant(d, secSid, FileSystemRights.Modify | FileSystemRights.Synchronize);
            foreach (var d in rx) Grant(d, secSid, FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize);
            foreach (var f in rxFiles) {
                var fi = new FileInfo(f); var acl = fi.GetAccessControl();
                acl.AddAccessRule(new FileSystemAccessRule(secSid, FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize, AccessControlType.Allow));
                fi.SetAccessControl(acl);
            }
        } catch (Exception e) { return Fail("ACL grant failed: " + e.Message); }
        if (i >= argv.Length) { Console.WriteLine(sidStr); return 0; }

        // Capabilities: none by default (no network). --net adds internetClient only.
        var caps = new List<IntPtr>();
        if (net) { IntPtr c; ConvertStringSidToSid("S-1-15-3-1", out c); caps.Add(c); }
        int saSize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
        IntPtr capArr = caps.Count > 0 ? Marshal.AllocHGlobal(saSize * caps.Count) : IntPtr.Zero;
        for (int k = 0; k < caps.Count; k++)
            Marshal.StructureToPtr(new SID_AND_ATTRIBUTES { Sid = caps[k], Attributes = 4 /*SE_GROUP_ENABLED*/ }, capArr + k * saSize, false);
        var sc = new SECURITY_CAPABILITIES { AppContainerSid = sid, Capabilities = capArr, CapabilityCount = (uint)caps.Count };
        IntPtr scPtr = Marshal.AllocHGlobal(Marshal.SizeOf(sc));
        Marshal.StructureToPtr(sc, scPtr, false);

        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr attr = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(attr, 1, 0, ref size)) return Fail("InitializeProcThreadAttributeList " + new Win32Exception().Message);
        if (!UpdateProcThreadAttribute(attr, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, scPtr, (IntPtr)Marshal.SizeOf(sc), IntPtr.Zero, IntPtr.Zero))
            return Fail("UpdateProcThreadAttribute " + new Win32Exception().Message);

        // Environment: the caller's, with TEMP/TMP moved into the container's own folder and markers added.
        var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables()) env[(string)e.Key] = (string)e.Value;
        if (folder != null) { env["TEMP"] = folder; env["TMP"] = folder; }
        env["ELEVARIQ_SANDBOX"] = "appcontainer:" + name;
        var eb = new StringBuilder();
        foreach (var kv in env) eb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
        eb.Append('\0');
        IntPtr envPtr = Marshal.StringToHGlobalUni(eb.ToString());

        var cmd = new StringBuilder();
        for (int k = i; k < argv.Length; k++) { if (k > i) cmd.Append(' '); cmd.Append(Quote(argv[k])); }

        var si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES
        si.StartupInfo.hStdInput = GetStdHandle(-10);
        si.StartupInfo.hStdOutput = GetStdHandle(-11);
        si.StartupInfo.hStdError = GetStdHandle(-12);
        si.lpAttributeList = attr;

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var lim = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        lim.Basic.LimitFlags = JOB_KILL_ON_CLOSE | (memMb > 0 ? JOB_MEMORY : 0);
        if (memMb > 0) lim.JobMemoryLimit = (UIntPtr)(ulong)(memMb * 1024 * 1024);
        if (!SetInformationJobObject(job, 9, ref lim, Marshal.SizeOf(lim))) return Fail("SetInformationJobObject " + new Win32Exception().Message);

        PROCESS_INFORMATION pi;
        if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, envPtr, cwd, ref si, out pi))
            return Fail("CreateProcess " + new Win32Exception().Message + " cmd=" + cmd);
        if (!AssignProcessToJobObject(job, pi.hProcess)) return Fail("AssignProcessToJobObject " + new Win32Exception().Message);
        ResumeThread(pi.hThread);
        if (WaitForSingleObject(pi.hProcess, timeoutMs) != 0) { TerminateJobObject(job, 124); Console.Error.WriteLine("sandbox-run: TIMEOUT, job terminated"); WaitForSingleObject(pi.hProcess, 5000); }
        uint code; GetExitCodeProcess(pi.hProcess, out code);
        var q = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        QueryInformationJobObject(job, 9, ref q, Marshal.SizeOf(q), IntPtr.Zero);
        Console.Error.WriteLine("sandbox-run: exit=" + (int)code + " peakJobMB=" + ((ulong)q.PeakJobMemoryUsed / (1024 * 1024)));
        return (int)code;
    }
}

