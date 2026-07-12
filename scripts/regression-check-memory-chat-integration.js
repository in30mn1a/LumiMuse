const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const chatEnginePath = path.join(root, 'src', 'lib', 'chat-engine.ts');
const source = fs.readFileSync(chatEnginePath, 'utf8');
const memoryPromptContractPath = path.join(root, 'src', 'lib', 'memory-prompt-contract.ts');
const memoryPromptContractSource = fs.readFileSync(memoryPromptContractPath, 'utf8');

const checks = [
  {
    name: 'chat-engine imports retrieveWorkingMemoryPackage',
    pass: /retrieveWorkingMemoryPackage/.test(source) && /@\/lib\/memory-retrieval/.test(source),
  },
  {
    name: 'runChat calls retrieveWorkingMemoryPackage before assembling prompt',
    pass: /await\s+retrieveWorkingMemoryPackage\s*\(/.test(source),
  },
  {
    name: 'limit_inject=false no longer selects all memory content for injection',
    pass: !/SELECT\s+content\s+FROM\s+memories\s+WHERE\s+character_id\s*=\s*\?/i.test(source),
  },
  {
    name: 'memory context uses the planned section title',
    pass: source.includes('MEMORY_CONTEXT_TITLE')
      && memoryPromptContractSource.includes("MEMORY_CONTEXT_TITLE = '## 记忆上下文'"),
  },
  {
    name: 'memory usage principles hide retrieval implementation details',
    pass: source.includes('MEMORY_USAGE_PRINCIPLES')
      && memoryPromptContractSource.includes('记忆条目、检索结果、分数、上下文'),
  },
  {
    name: 'memory usage principles keep current user message authoritative',
    pass: source.includes('MEMORY_USAGE_PRINCIPLES')
      && memoryPromptContractSource.includes('旧记忆和当前消息冲突，以当前消息为准'),
  },
  {
    name: 'assemblePrompt accepts pre-rendered working memory text without numbering it',
    pass: /typeof\s+memories\s*===\s*'string'/.test(source),
  },
];

const failed = checks.filter(check => !check.pass);

for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}`);
}

if (failed.length > 0) {
  console.error(`\n${failed.length} memory chat integration check(s) failed.`);
  process.exit(1);
}

console.log('\nMemory chat integration checks passed.');
