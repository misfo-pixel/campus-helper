// 三个发布页（二手 / 转租 / 委托）共用的「上传 + 送审」。
//
// 原来的发布是一条长链，每一步都等上一步回来：
//   文字审核 → 图1 → 图2 → 图3 → 图片审核 → 缩略图 → 写库
// 云开发在国内、用户在美国，每一步都是一趟跨太平洋往返（约 300ms），加起来 5 秒往上。
//
// 现在用户只等一件事：以 reviewing 状态写库。
// 图片在选完的那一刻就开始在后台上传了（createUploader），点发布时多半已经传完
// 审核挪到用户看不见的地方：写完库发一个请求给 contentCheck，不等它回来。
// 审核中的帖子列表页查不到，所以没审过的内容依然不会公开。
const { uploadThumb } = require('./thumb.js')
const { markStale } = require('./refresh.js')
const { deleteCloudFiles } = require('./contentCheck.js')

// 选图即上传。每个发布页 onLoad 时建一个：
//   选图 / 删图之后 → uploader.sync(当前的图片列表)
//   点发布         → await uploader.collect(当前的图片列表)
//   写库成功       → uploader.commit()
//   离开页面       → uploader.discard()
//
// 用户填标题、价格、描述的那几十秒，图已经在后台传了。点发布时多半已经传完，
// 只剩写库那一趟往返——这就是闲鱼「点了就好」的秘诀之一：把活挪到用户看不见的时间里。
//
// 表里存的是 Promise（「将来会拿到 fileID」），不是 fileID。
// 这样不管某张图是传完了、还在传、还是失败了，collect 都用同一种写法拿结果。
function createUploader(dir) {
  const originals = {}   // 本地临时路径 → Promise<fileID>
  const thumbs = {}      // 首图的本地路径 → Promise<缩略图 fileID>
  let n = 0

  function start(path) {
    if (!originals[path]) {
      const task = wx.cloud.uploadFile({
        cloudPath: dir + '/' + Date.now() + '_' + (n++) + '.jpg',
        filePath: path
      }).then(r => r.fileID)
      // 传失败了就从表里拿掉，点发布时 collect 会重传一次
      task.catch(err => {
        console.error('后台上传失败，发布时重试：', err)
        if (originals[path] === task) delete originals[path]
      })
      originals[path] = task
    }
    return originals[path]
  }

  function startThumb(path) {
    if (!path) return Promise.resolve('')
    if (!thumbs[path]) thumbs[path] = uploadThumb(path, dir)   // 自己会降级成 ''，不会失败
    return thumbs[path]
  }

  // 用户删掉的图已经传上去了（或正在传），等它传完再删，不然云存储里会攒孤儿文件
  function drop(table, path) {
    const task = table[path]
    if (!task) return
    delete table[path]
    task.then(id => id && deleteCloudFiles([id])).catch(() => {})
  }

  return {
    // 让云端和当前选的图保持一致：新图开始传，删掉的图清理掉；首图换了，缩略图跟着换
    sync: function (paths) {
      paths.forEach(start)
      Object.keys(originals).filter(p => paths.indexOf(p) === -1).forEach(p => drop(originals, p))
      Object.keys(thumbs).filter(p => p !== paths[0]).forEach(p => drop(thumbs, p))
      startThumb(paths[0])
    },
    // 点发布时拿结果：传完的直接用，没传完的等，失败过的重传
    collect: function (paths) {
      return Promise.all([Promise.all(paths.map(start)), startThumb(paths[0])])
        .then(([images, thumb]) => ({ images: images, thumb: thumb }))
    },
    // 已经写进帖子了，这些文件归帖子所有，表清空但不删文件
    commit: function () {
      Object.keys(originals).forEach(p => delete originals[p])
      Object.keys(thumbs).forEach(p => delete thumbs[p])
    },
    // 没发布就走了：传上去的全删掉
    discard: function () {
      Object.keys(originals).forEach(p => drop(originals, p))
      Object.keys(thumbs).forEach(p => drop(thumbs, p))
    }
  }
}

// 送审，不等结果。quiet 用于「我的发布」页的自动补审：没通过时照样提醒，
// 但通过了不用再弹提示，列表刷新就能看到。
function requestReview(type, id, title, quiet) {
  return wx.cloud.callFunction({ name: 'contentCheck', data: { review: { type: type, id: id } } })
    .then(res => {
      const r = (res && res.result) || {}
      if (!r.success || r.retry) return r      // 服务暂时不可用：帖子留在审核中，下次打开「我的发布」再补审
      markStale(type)                           // 状态变了，列表回来时要刷新
      if (r.status === 'rejected') {
        // 这时用户多半已经离开发布页了，showModal 是全局的，在哪一页都能弹出来
        wx.showModal({
          title: '内容未通过审核',
          content: '「' + title + '」' + (r.reason || '可能包含违规信息') + '，没有公开。请修改后重新发布。',
          showCancel: false,
          confirmText: '我知道了'
        })
      } else if (!quiet) {
        wx.showToast({ title: '审核通过，已公开', icon: 'none' })
      }
      return r
    })
    .catch(err => {
      // 请求没发出去也不要紧：帖子停在审核中，不会公开，之后会被自动补审
      console.error('送审失败，稍后自动补审：', err)
      return { success: false }
    })
}

// 「我的发布」页打开时调用：把卡在审核中的帖子重新送审。
// 卡住的原因可能是发完就断网、送审请求没发出去，或者当时审核服务不可用。
// 刚发出去的不补：它的审核请求多半还在路上，补了也只是白跑一趟（contentCheck 本身是幂等的，重复也不会出错）
const STUCK_MS = 30 * 1000
function retryStuckReviews(type, docs) {
  const now = Date.now()
  ;(docs || [])
    .filter(d => d.status === 'reviewing' && now - new Date(d.created_at).getTime() > STUCK_MS)
    .slice(0, 5)
    .forEach(d => requestReview(type, d._id, d.title, true))
}

module.exports = {
  createUploader: createUploader,
  requestReview: requestReview,
  retryStuckReviews: retryStuckReviews
}
