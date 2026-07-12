const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function extractWorkflowJob(source, jobName) {
  const marker = `  ${jobName}:`;
  const start = source.indexOf(marker);
  if (start === -1) return '';
  const remainder = source.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-zA-Z0-9_-]+:\s*$/m);
  return nextJob === -1 ? source.slice(start) : source.slice(start, start + marker.length + nextJob);
}

test('CI pins action references and the Ubuntu runner to immutable versions', () => {
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const actionReferences = [...ci.matchAll(/^\s*uses:\s*([^\s@]+)@([^\s#]+).*$/gm)];

  assert.ok(actionReferences.length >= 2, 'expected the CI workflow to use pinned actions');
  for (const [, action, reference] of actionReferences) {
    assert.match(reference, /^[0-9a-f]{40}$/, `${action} must use a full commit SHA`);
  }

  assert.doesNotMatch(ci, /runs-on:\s*ubuntu-latest\b/);
  assert.match(ci, /runs-on:\s*ubuntu-(?:22\.04|24\.04)\b/);
});

test('Docker stages pin node:20-slim to one multi-architecture manifest digest', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const fromReferences = [...dockerfile.matchAll(/^FROM\s+node:20-slim@sha256:([0-9a-f]{64})\s+AS\s+\w+\s*$/gm)];

  assert.equal(fromReferences.length, 3, 'all three Node stages must pin a digest');
  assert.equal(new Set(fromReferences.map((match) => match[1])).size, 1);
});

test('Dependabot maintains GitHub Actions and Docker pinned references', () => {
  const dependabot = fs.readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8');

  assert.match(dependabot, /package-ecosystem:\s*["']github-actions["']/);
  assert.match(dependabot, /package-ecosystem:\s*["']docker["']/);
  assert.match(dependabot, /directory:\s*["']\/["']/);
  assert.match(dependabot, /interval:\s*["']weekly["']/);
});

test('CI has an isolated Docker delivery smoke with readiness and unconditional cleanup', () => {
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = extractWorkflowJob(ci, 'docker-smoke');

  assert.notEqual(job, '', 'expected a separate docker-smoke job');
  assert.match(job, /needs:\s*verify/);
  assert.match(job, /runs-on:\s*ubuntu-24\.04\b/);
  assert.match(job, /docker build\b/);
  assert.match(job, /--build-arg\s+LUMIMUSE_BUILD_SHA="?\$\{?GITHUB_SHA\}?"?/);
  assert.match(job, /docker run\b/);
  assert.match(job, /ACCESS_PASSWORD/);
  assert.match(job, /AUTH_SECRET/);
  assert.match(job, /\/api\/health\?ready=1/);
  assert.match(job, /parsed\.build\s*!==\s*process\.env\.GITHUB_SHA/);
  assert.match(job, /process\.getuid\(\)/);
  assert.match(job, /process\.getuid\(\) !== 1001/);
  assert.doesNotMatch(job, /--user\b/, 'smoke must verify the image default USER rather than overriding it');
  assert.match(job, /docker logs/);
  assert.match(job, /if:\s*failure\(\)/);
  assert.match(job, /if:\s*always\(\)/);
  assert.match(job, /docker rm\b/);
  assert.match(job, /docker volume rm\b/);

  const mountedVolumes = [...job.matchAll(/-v\s+"?\$[A-Z_]+:\/app\/(?:data|public\/(?:generated|avatars|attachments))"?/g)];
  assert.equal(mountedVolumes.length, 4, 'expected named volumes for all four persistent paths');
  assert.ok((job.match(/docker volume create/g) || []).length >= 4);
});

test('Docker and Compose propagate a build SHA into the runtime health metadata', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

  assert.match(dockerfile, /ARG LUMIMUSE_BUILD_SHA=local/);
  assert.match(dockerfile, /ENV LUMIMUSE_BUILD_SHA=\$LUMIMUSE_BUILD_SHA/);
  assert.match(compose, /LUMIMUSE_BUILD_SHA:\s*\$\{LUMIMUSE_BUILD_SHA:-local\}/);
});

test('CI deduplicates push and pull_request runs by source commit and Docker uses plain npm ci', () => {
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

  assert.match(ci, /on:\s*\n\s+push:\s*\n\s+pull_request:/);
  assert.match(ci, /group:\s*ci-\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.sha\s*\}\}/);
  assert.doesNotMatch(ci, /group:[^\n]*github\.ref/, 'push and pull_request refs differ for the same source commit');
  assert.match(ci, /cancel-in-progress:\s*true/);
  assert.match(dockerfile, /RUN npm ci\s*$/m);
  assert.doesNotMatch(dockerfile, /npm ci[^\n]*--frozen-lockfile/);
});

test('Compose bounds container log growth with local rotation settings', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');

  assert.match(compose, /logging:\s*\n\s+driver:\s*["']?json-file["']?/);
  assert.match(compose, /max-size:\s*["']10m["']/);
  assert.match(compose, /max-file:\s*["']3["']/);
});
