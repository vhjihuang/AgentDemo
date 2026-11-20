import chalk from 'chalk';

/** 打印居中分隔标题,把各阶段的终端输出分组,方便阅读日志。 */
export function logTitle(message: string) {
  const totalLength = 80;
  const messageLength = message.length;
  // 4 对应两边的 "== " 与 " ==" 前后缀;fro 是原拼写错误(fro → for)
  const padding = Math.max(0, totalLength - messageLength - 4);
  const paddingMessage = `${'='.repeat(Math.floor(padding / 2))} ${message} ${'='.repeat(Math.ceil(padding / 2))}`;
  console.log(chalk.bold.cyanBright(paddingMessage))
}

// TODO(dev): 死代码,未在任何地方引用,应删除。
export function hello() {
    console.log("Hello, world!");
}
