// ESLint 配置。刻意只开两条规则，不做代码风格检查。
//
// 起因：2026-09-20 重构时把 checkSlot 里的 `const d = new Date()` 删了，
// 但下面五行还在用 d。语法完全合法，`node --check` 查不出来，
// 直到当天的场次日期对上才在运行时抛 ReferenceError，
// 表现成「店长工作台看不到自己的店」——排查了半天才定位到。
//
// no-undef 能在保存文件的那一刻就标红这种「删了定义、忘了引用」。
// 风格问题（缩进、引号、分号）不在这里管：那是审美，交给人。

const globals = require('globals')

// 小程序运行时注入的全局对象。它既不是浏览器也不是 Node，
// 所以 globals 包里没有现成的一份，得自己列。
const miniprogramGlobals = {
  wx: 'readonly',
  App: 'readonly',
  Page: 'readonly',
  Component: 'readonly',
  Behavior: 'readonly',
  getApp: 'readonly',
  getCurrentPages: 'readonly',
  requirePlugin: 'readonly',
  __wxConfig: 'readonly',
  // 宿主提供、但不属于 JS 语言本身的那几个
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly'
}

const rules = {
  // 用了一个当前作用域链上不存在的名字。这是本配置存在的唯一理由。
  'no-undef': 'error',

  // 声明了却没用到。多数时候是删改留下的残渣，偶尔是真忘了用。
  // args: 'none'         —— 回调形参经常用不上（err、res），不值得报。
  // caughtErrors: 'none' —— catch (e) 里不看 e 是这个项目里的常见写法，
  //                         全报出来会淹掉真正有价值的那几条。
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }]
}

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'miniprogram/miniprogram_npm/**',
      'cloudfunctions/*/node_modules/**'
    ]
  },
  {
    // 小程序端：页面、组件、utils
    files: ['miniprogram/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: Object.assign({}, globals.es2021, miniprogramGlobals)
    },
    rules: rules
  },
  {
    // 云函数：跑在 Node 里，全局环境和小程序端完全不同
    files: ['cloudfunctions/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node
    },
    rules: rules
  },
  {
    // 配置文件自己也跑在 Node 里
    files: ['eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: rules
  }
]
