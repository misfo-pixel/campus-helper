// 生活百科正文的 Markdown 渲染：不引 towxml / wemark 这类库（几百 KB，词条只用得到
// 标题、加粗、列表、引用、链接这一小撮语法），自己写了个几十行的解析器，
// 输出 rich-text 的 nodes。包体积几乎不增加，语法不够用了再换库。
//
// 支持：## 二级标题、### 三级标题、- 无序列表、1. 有序列表、> 引用、
//       **加粗**、[文字](链接)、普通段落。链接在 WXML 里点不了，渲染成带下划线的文字，
//       来源链接统一走详情页底部的来源列表（可以复制）。

function inline(text) {
  // 把 **bold** 和 [text](url) 转成 rich-text 的内联节点
  const nodes = []
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push({ type: 'text', text: text.slice(last, m.index) })
    if (m[1] !== undefined) {
      nodes.push({ name: 'strong', children: [{ type: 'text', text: m[1] }] })
    } else {
      nodes.push({ name: 'span', attrs: { class: 'md-link' }, children: [{ type: 'text', text: m[2] }] })
    }
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) })
  return nodes
}

function block(name, children, className) {
  return { name: name, attrs: { class: className || ('md-' + name) }, children: children }
}

// markdown 字符串 → rich-text nodes
function render(md) {
  const out = []
  const lines = String(md || '').split('\n')
  let list = null   // 正在累积的列表

  function flushList() {
    if (list) { out.push(list); list = null }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) { flushList(); continue }

    let m
    if ((m = /^(#{2,3})\s+(.*)$/.exec(line))) {
      flushList()
      out.push(block(m[1].length === 2 ? 'h2' : 'h3', inline(m[2])))
    } else if ((m = /^[-*]\s+(.*)$/.exec(line))) {
      if (!list || list.name !== 'ul') { flushList(); list = block('ul', []) }
      list.children.push(block('li', inline(m[1])))
    } else if ((m = /^\d+[.、]\s*(.*)$/.exec(line))) {
      if (!list || list.name !== 'ol') { flushList(); list = block('ol', []) }
      list.children.push(block('li', inline(m[1])))
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flushList()
      out.push(block('blockquote', inline(m[1])))
    } else {
      flushList()
      out.push(block('p', inline(line)))
    }
  }
  flushList()
  return out
}

module.exports = { render }
