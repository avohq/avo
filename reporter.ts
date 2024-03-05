import chalk from 'chalk';

export function log(text: string) {
  console.log(text);
}

export function info(text: string) {
  console.log(chalk.blue('info'), text);
}

export function success(text: string) {
  console.log(chalk.green('success'), text);
}

export function warn(text: string) {
  console.log(chalk.yellow('warn'), text);
}

export function error(text: string) {
  console.log(chalk.red('error'), text);
}

export function tree(text: string, children) {
  function recursiveTree(name = '', nodes = [], prefix = '') {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    return `${name}\n${nodes
      .map((node, index) => {
        const last = index === nodes.length - 1;

        return `${prefix}${last ? '└' : '├'}─ ${recursiveTree(node.name, node.children, `${prefix}${last ? ' ' : '│'}  `)}`;
      })
      .join('')}`;
  }
  console.log(recursiveTree(text, children));
}
