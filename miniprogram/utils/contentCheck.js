// 内容安全检测的前端入口。所有用户产生的内容写库之前都要先过这里。
//
// 注意这是「fail-closed」的：云函数没部署、网络断了、接口报错，
// 一律当作没通过。宁可让用户重试一次，也不能放没检测过的内容进库——
// 微信审核查的就是这条链路有没有真的拦得住。

// 检测内容。texts 是要检的文字，fileIDs 是已经传到云存储的图片。
// scene: 1 资料 / 2 评论 / 3 论坛 / 4 社交日志
function checkContent(options) {
  return wx.cloud.callFunction({
    name: 'contentCheck',
    data: {
      texts: options.texts || [],
      fileIDs: options.fileIDs || [],
      scene: options.scene || 3
    }
  }).then(res => {
    const r = (res && res.result) || {}
    if (!r.success) {
      return { pass: false, serviceError: true, reason: '内容校验失败，请稍后重试' }
    }
    return { pass: !!r.pass, serviceError: !!r.serviceError, reason: r.reason || '' }
  }).catch(err => {
    console.error('contentCheck 调用失败：', err)
    return { pass: false, serviceError: true, reason: '内容校验服务暂时不可用，请稍后重试' }
  })
}

// 检测 + 未通过时直接弹提示。页面里写成：
//   if (!(await ensureContentOk({ texts: [...] }))) return
// 未通过时会先 hideLoading，页面不用自己收拾。
function ensureContentOk(options) {
  return checkContent(options).then(result => {
    if (!result.pass) {
      wx.hideLoading()
      wx.showModal({
        title: '内容未通过审核',
        content: result.reason || '内容可能包含违规信息，请修改后重新提交',
        showCancel: false,
        confirmText: '我知道了'
      })
    }
    return result.pass
  })
}

// 图片没过检时把已经传上去的文件删掉，不然云存储里会攒一堆孤儿文件
function deleteCloudFiles(fileIDs) {
  if (!fileIDs || fileIDs.length === 0) return Promise.resolve()
  return wx.cloud.deleteFile({ fileList: fileIDs }).catch(err => {
    console.error('清理未过审图片失败：', err)
  })
}

module.exports = {
  checkContent: checkContent,
  ensureContentOk: ensureContentOk,
  deleteCloudFiles: deleteCloudFiles
}
