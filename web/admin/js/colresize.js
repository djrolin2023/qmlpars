// 通用表格列宽拖拽 + 记忆（类似 Excel 列宽）
// 用法：initColResize(tableId, colKeys, defaults, storeKey)
//  - tableId: 表格元素 id
//  - colKeys: 列 key 数组（与 th 的 data-col 对应）
//  - defaults: { key: 默认宽度(px) }
//  - storeKey: localStorage 存储键（区分不同表格）
//  - opts.lastFixed: 最后一列 key（不可拖拽）
(function () {
  function initColResize(tableId, colKeys, defaults, storeKey, opts) {
    opts = opts || {}
    var lastFixed = opts.lastFixed || null
    var table = document.getElementById(tableId)
    if (!table) return
    table.classList.add('col-resizable')
    // 默认撑满容器；用户一旦拖拽过任意列，就移除 cr-fit 切换到 max-content
    var hasCustom = Object.keys(load()).length > 0
    if (!hasCustom) table.classList.add('cr-fit')
    var colgroup = table.querySelector('colgroup')
    if (!colgroup) {
      colgroup = document.createElement('colgroup')
      table.insertBefore(colgroup, table.firstChild)
    }

    function load() {
      try { return JSON.parse(localStorage.getItem(storeKey) || '{}') || {} } catch (e) { return {} }
    }
    function save(w) { try { localStorage.setItem(storeKey, JSON.stringify(w)) } catch (e) {} }

    function apply() {
      var saved = load()
      colgroup.innerHTML = colKeys.map(function (k) {
        var w = saved[k] != null ? saved[k] : (defaults[k] || 100)
        return '<col data-col="' + k + '" style="width:' + w + 'px">'
      }).join('')
    }

    function initResizers() {
      var ths = table.querySelectorAll('thead th[data-col]')
      ths.forEach(function (th) {
        var col = th.dataset.col
        if (col === lastFixed) return // 最后一列固定，不拖
        var rz = document.createElement('div')
        rz.className = 'col-resizer'
        th.appendChild(rz)
        var startX = 0, startW = 0, dragging = false
        rz.addEventListener('mousedown', function (e) {
          e.preventDefault()
          dragging = true
          rz.classList.add('active')
          startX = e.clientX
          var colEl = colgroup.querySelector('col[data-col="' + col + '"]')
          startW = colEl ? colEl.offsetWidth : (defaults[col] || 100)
          document.body.style.cursor = 'col-resize'
          function onMove(ev) {
            if (!dragging) return
            var nw = Math.max(40, startW + (ev.clientX - startX))
            var el = colgroup.querySelector('col[data-col="' + col + '"]')
            if (el) el.style.width = nw + 'px'
          }
          function onUp() {
            if (!dragging) return
            dragging = false
            rz.classList.remove('active')
            document.body.style.cursor = ''
            var el = colgroup.querySelector('col[data-col="' + col + '"]')
            var s = load()
            s[col] = el ? Math.round(el.offsetWidth) : (defaults[col] || 100)
            save(s)
            // 用户调整过列宽，切换到 max-content 模式（Excel 式），不再强制撑满
            table.classList.remove('cr-fit')
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
          }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        })
      })
    }

    apply()
    initResizers()
  }

  window.initColResize = initColResize
})()
