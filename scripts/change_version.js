const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const packagePath = path.resolve(__dirname, '..', 'package.json');

if (!fs.existsSync(packagePath)) {
  console.error(`[错误] 找不到 package.json 文件！路径: ${packagePath}`);
  process.exit(1);
}

try {
  const packageData = fs.readFileSync(packagePath, 'utf8');
  const packageJson = JSON.parse(packageData);
  const currentVersion = packageJson.version;

  console.log('\n========================================================');
  console.log(`当前软件版本为: ${currentVersion}`);
  console.log('========================================================\n');

  rl.question('请输入新的版本号 (例如: 1.0.4) 并按回车: ', (newVersion) => {
    newVersion = newVersion.trim();
    if (!newVersion) {
      console.log('[取消] 未输入任何版本号，已退出。');
      rl.close();
      return;
    }

    console.log(`\n你输入的新版本号是: ${newVersion}`);
    rl.question('是否确认修改? (Y/N): ', (confirm) => {
      if (confirm.trim().toLowerCase() !== 'y') {
        console.log('[取消] 用户取消了操作。');
        rl.close();
        return;
      }

      packageJson.version = newVersion;
      fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      
      console.log(`\n[成功] package.json 的版本号已更新为: ${newVersion}`);
      console.log('[提示] 重新启动软件或重新打包即可看到新的版本号。\n');
      rl.close();
    });
  });

} catch (err) {
  console.error(`[错误] 处理失败: ${err.message}`);
  process.exit(1);
}
