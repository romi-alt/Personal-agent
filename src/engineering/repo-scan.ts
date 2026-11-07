import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Deterministic repository intelligence: what exists before the agent changes anything. Reads files only (never runs
 * repository code), skips dependency/build folders, and is bounded in files and bytes. The profile is stored with
 * the project and given to planning and coding workers so working implementations are not overwritten blindly.
 */
export interface RepoProfile {
  scannedAt: number;
  root: string;
  files: number;
  truncated: boolean;
  languages: Record<string, number>;
  topLevel: string[];
  manifests: {
    file: string;
    kind: string;
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: string[];
    devDependencies?: string[];
  }[];
  frameworks: string[];
  tests: { dirs: string[]; files: number; frameworks: string[] };
  build: { commands: Record<string, string> };
  database: { migrationDirs: string[]; schemaFiles: string[]; orms: string[] };
  apis: { specFiles: string[]; routeFiles: number };
  deployment: { files: string[] };
  ci: { files: string[] };
  docs: string[];
  knownDefects: { todo: number; fixme: number; samples: string[] };
}

const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  '.next',
  '.nuxt',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  'bin',
  'obj',
]);
const EXT_LANG: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.php': 'PHP',
  '.rb': 'Ruby',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.cs': 'C#',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.sql': 'SQL',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.html': 'HTML',
  '.dart': 'Dart',
  '.swift': 'Swift',
};
const FRAMEWORK_DEPS: Record<string, string> = {
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  nuxt: 'Nuxt',
  svelte: 'Svelte',
  '@angular/core': 'Angular',
  express: 'Express',
  fastify: 'Fastify',
  '@nestjs/core': 'NestJS',
  koa: 'Koa',
  hono: 'Hono',
  prisma: 'Prisma',
  '@prisma/client': 'Prisma',
  typeorm: 'TypeORM',
  sequelize: 'Sequelize',
  'drizzle-orm': 'Drizzle',
  mongoose: 'Mongoose',
  knex: 'Knex',
  vitest: 'Vitest',
  jest: 'Jest',
  mocha: 'Mocha',
  '@playwright/test': 'Playwright',
  cypress: 'Cypress',
  tailwindcss: 'Tailwind',
  django: 'Django',
  flask: 'Flask',
  fastapi: 'FastAPI',
  sqlalchemy: 'SQLAlchemy',
  pytest: 'pytest',
  'laravel/framework': 'Laravel',
};

export function scanRepository(
  root: string,
  limits = { maxFiles: 20_000, maxReadBytes: 256 * 1024 },
): RepoProfile {
  const p: RepoProfile = {
    scannedAt: Date.now(),
    root,
    files: 0,
    truncated: false,
    languages: {},
    topLevel: [],
    manifests: [],
    frameworks: [],
    tests: { dirs: [], files: 0, frameworks: [] },
    build: { commands: {} },
    database: { migrationDirs: [], schemaFiles: [], orms: [] },
    apis: { specFiles: [], routeFiles: 0 },
    deployment: { files: [] },
    ci: { files: [] },
    docs: [],
    knownDefects: { todo: 0, fixme: 0, samples: [] },
  };
  if (!existsSync(root)) return p;
  p.topLevel = readdirSync(root)
    .filter((n) => !SKIP.has(n))
    .sort()
    .slice(0, 100);
  const frameworks = new Set<string>();
  const testFw = new Set<string>();
  let readBudget = limits.maxReadBytes * 40;
  const walk = (dir: string, depth: number) => {
    if (p.truncated || depth > 12) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP.has(name)) continue;
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (/(^|\/)(tests?|__tests__|spec|e2e)$/i.test(rel)) p.tests.dirs.push(rel);
        if (/(^|\/)(migrations?|db\/migrate|prisma\/migrations|alembic)$/i.test(rel))
          p.database.migrationDirs.push(rel);
        walk(abs, depth + 1);
        continue;
      }
      if (++p.files > limits.maxFiles) {
        p.truncated = true;
        return;
      }
      const ext = path.extname(name).toLowerCase();
      const lang = EXT_LANG[ext];
      if (lang) p.languages[lang] = (p.languages[lang] ?? 0) + 1;
      if (/\.(test|spec)\.[a-z]+$|^test_.*\.py$|_test\.go$/i.test(name)) p.tests.files++;
      if (/^(schema\.prisma|schema\.sql|structure\.sql|models\.py)$/i.test(name))
        p.database.schemaFiles.push(rel);
      if (/^(openapi|swagger)\.(ya?ml|json)$/i.test(name)) p.apis.specFiles.push(rel);
      if (/(^|\/)(routes?|controllers?|api)\//i.test(rel) && lang) p.apis.routeFiles++;
      if (
        /^(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|Procfile|.*\.service|nginx\.conf|vercel\.json|netlify\.toml|fly\.toml|app\.yaml)$/i.test(
          name,
        )
      )
        p.deployment.files.push(rel);
      if (/^\.github\/workflows\/|^\.gitlab-ci\.yml$|^azure-pipelines\.yml$|^\.circleci\//.test(rel))
        p.ci.files.push(rel);
      if (/^(readme|architecture|contributing|changelog)(\.[a-z]+)?$/i.test(name) || /^docs\//.test(rel))
        if (p.docs.length < 50) p.docs.push(rel);
      if (
        [
          'package.json',
          'composer.json',
          'pyproject.toml',
          'requirements.txt',
          'go.mod',
          'Cargo.toml',
          'pom.xml',
          'build.gradle',
          'Gemfile',
        ].includes(name) &&
        !rel.includes('/node_modules/')
      )
        readManifest(abs, rel, name);
      if (lang && st.size < limits.maxReadBytes && readBudget > 0) {
        readBudget -= st.size;
        try {
          const text = readFileSync(abs, 'utf8');
          for (const m of text.matchAll(/\b(TODO|FIXME)\b[:\s]*(.{0,80})/g)) {
            if (m[1] === 'TODO') p.knownDefects.todo++;
            else p.knownDefects.fixme++;
            if (p.knownDefects.samples.length < 15)
              p.knownDefects.samples.push(`${rel}: ${m[1]} ${m[2]!.trim()}`);
          }
        } catch {
          /* unreadable */
        }
      }
    }
  };
  const readManifest = (abs: string, rel: string, name: string) => {
    try {
      const text = readFileSync(abs, 'utf8');
      if (name === 'package.json') {
        const j = JSON.parse(text) as {
          name?: string;
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const deps = Object.keys(j.dependencies ?? {});
        const dev = Object.keys(j.devDependencies ?? {});
        p.manifests.push({
          file: rel,
          kind: 'npm',
          name: j.name,
          scripts: j.scripts,
          dependencies: deps.slice(0, 80),
          devDependencies: dev.slice(0, 80),
        });
        for (const d of [...deps, ...dev]) if (FRAMEWORK_DEPS[d]) frameworks.add(FRAMEWORK_DEPS[d]);
        for (const d of dev)
          if (['vitest', 'jest', 'mocha', '@playwright/test', 'cypress'].includes(d))
            testFw.add(FRAMEWORK_DEPS[d]!);
        if (rel === 'package.json')
          for (const k of ['build', 'test', 'lint', 'typecheck', 'start', 'dev'])
            if (j.scripts?.[k]) p.build.commands[k] = `npm run ${k}`;
      } else if (name === 'composer.json') {
        const j = JSON.parse(text) as { name?: string; require?: Record<string, string> };
        const deps = Object.keys(j.require ?? {});
        p.manifests.push({ file: rel, kind: 'composer', name: j.name, dependencies: deps.slice(0, 80) });
        for (const d of deps) if (FRAMEWORK_DEPS[d]) frameworks.add(FRAMEWORK_DEPS[d]);
      } else {
        const deps = [...text.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*[=<>~!]/gm)]
          .map((m) => m[1]!.toLowerCase())
          .slice(0, 80);
        p.manifests.push({ file: rel, kind: name, dependencies: deps });
        for (const d of deps) if (FRAMEWORK_DEPS[d]) frameworks.add(FRAMEWORK_DEPS[d]);
        if (deps.includes('pytest')) testFw.add('pytest');
      }
    } catch {
      p.manifests.push({ file: rel, kind: name });
    }
  };
  walk(root, 0);
  p.frameworks = [...frameworks].sort();
  p.tests.frameworks = [...testFw].sort();
  p.database.orms = p.frameworks.filter((f) =>
    ['Prisma', 'TypeORM', 'Sequelize', 'Drizzle', 'Mongoose', 'Knex', 'SQLAlchemy'].includes(f),
  );
  return p;
}

/** Compact text form for prompts (bounded). */
export function renderRepoProfile(p: RepoProfile): string {
  const langs = Object.entries(p.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} ${n}`)
    .join(', ');
  return [
    `## Existing repository profile (scanned ${new Date(p.scannedAt).toISOString()}, ${p.files} files${p.truncated ? ', truncated' : ''})`,
    `Top level: ${p.topLevel.join(', ') || '(empty)'}`,
    `Languages: ${langs || 'none'}`,
    `Frameworks: ${p.frameworks.join(', ') || 'none detected'}`,
    `Manifests: ${p.manifests.map((m) => `${m.file}${m.name ? ` (${m.name})` : ''}`).join(', ') || 'none'}`,
    `Build/test commands: ${Object.values(p.build.commands).join(', ') || 'none detected'}`,
    `Tests: ${p.tests.files} test files in ${p.tests.dirs.slice(0, 10).join(', ') || '-'}; frameworks: ${p.tests.frameworks.join(', ') || '-'}`,
    `Database: migrations ${p.database.migrationDirs.join(', ') || '-'}; schema ${p.database.schemaFiles.join(', ') || '-'}; ORMs ${p.database.orms.join(', ') || '-'}`,
    `APIs: specs ${p.apis.specFiles.join(', ') || '-'}; ${p.apis.routeFiles} route/controller files`,
    `Deployment: ${p.deployment.files.join(', ') || '-'}; CI: ${p.ci.files.join(', ') || '-'}`,
    `Known defects: ${p.knownDefects.todo} TODO, ${p.knownDefects.fixme} FIXME${
      p.knownDefects.samples.length
        ? `\n${p.knownDefects.samples
            .slice(0, 8)
            .map((s) => `  - ${s}`)
            .join('\n')}`
        : ''
    }`,
    'Rule: inspect and extend what exists; do not overwrite or replace working implementations without a stated justification.',
  ].join('\n');
}
