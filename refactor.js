const fs = require('fs');
const path = require('path');

const targetDirs = [__dirname, path.join(__dirname, 'routes')];

function processFile(filePath) {
  if (!filePath.endsWith('.js') || filePath.endsWith('db.js') || filePath.endsWith('refactor.js')) return;
  let content = fs.readFileSync(filePath, 'utf8');

  // Prefix with await if not already there
  let newContent = content.replace(/(?<!await\s+)(getOne|getAll|runSql)\(/g, 'await $1(');

  if (newContent !== content) {
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log('Updated', filePath);
  }
}

targetDirs.forEach(dir => {
  fs.readdirSync(dir).forEach(file => {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isFile()) {
      processFile(fullPath);
    }
  });
});
