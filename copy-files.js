const fs = require('fs');
const path = require('path');

const basePath = 'D:\\AI买卖房平台';

// 1. Create searchResult directory and copy files from candidates
const srcDir = path.join(basePath, 'pages', 'candidates');
const destDir = path.join(basePath, 'pages', 'searchResult');

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
  console.log('Created directory:', destDir);
}

const files = ['index.js', 'index.json', 'index.wxml', 'index.wxss'];
files.forEach(file => {
  const srcPath = path.join(srcDir, file);
  const destPath = path.join(destDir, file);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
    console.log('Copied:', file);
  }
});

// 2. Update searchResult/index.js to fix login redirect path
const searchResultJs = path.join(destDir, 'index.js');
if (fs.existsSync(searchResultJs)) {
  let content = fs.readFileSync(searchResultJs, 'utf8');
  content = content.replace(
    'requireLogin("/pages/candidates/index")',
    'requireLogin("/pages/searchResult/index")'
  );
  fs.writeFileSync(searchResultJs, content, 'utf8');
  console.log('Updated searchResult/index.js login redirect');
}

// 3. Update searchResult/index.json title
const searchResultJson = path.join(destDir, 'index.json');
if (fs.existsSync(searchResultJson)) {
  let content = fs.readFileSync(searchResultJson, 'utf8');
  content = content.replace('"传统搜索"', '"搜索结果"');
  fs.writeFileSync(searchResultJson, content, 'utf8');
  console.log('Updated searchResult/index.json title');
}

// 4. Delete unnecessary page directories
const dirsToDelete = ['action', 'compare', 'risk', 'adminLeadDetail', 'adminLeads', 'intake', 'candidates'];
dirsToDelete.forEach(dir => {
  const dirPath = path.join(basePath, 'pages', dir);
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    console.log('Deleted directory:', dir);
  }
});

// 5. Update pages/login/index.js
const loginJs = path.join(basePath, 'pages', 'login', 'index.js');
if (fs.existsSync(loginJs)) {
  let content = fs.readFileSync(loginJs, 'utf8');
  // Replace candidates with searchResult
  content = content.replace(/\/pages\/candidates\/index/g, '/pages/searchResult/index');
  // Remove deleted page references
  content = content.replace(/,?\s*"\/pages\/intake\/index":\s*\{[^}]+\}/g, '');
  content = content.replace(/,?\s*"\/pages\/compare\/index":\s*\{[^}]+\}/g, '');
  content = content.replace(/,?\s*"\/pages\/risk\/index":\s*\{[^}]+\}/g, '');
  content = content.replace(/,?\s*"\/pages\/action\/index":\s*\{[^}]+\}/g, '');
  fs.writeFileSync(loginJs, content, 'utf8');
  console.log('Updated pages/login/index.js');
}

console.log('All tasks completed!');
console.log('');
console.log('IMPORTANT: Please run this script with: node copy-files.js');
console.log('Then verify the changes and test the mini program.');
