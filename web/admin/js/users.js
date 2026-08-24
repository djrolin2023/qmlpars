function initUsers() {
  const userBody = document.getElementById('userBody')
  const emptyTip = document.getElementById('emptyTip')
  const addHint = document.getElementById('addHint')
  const modal = document.getElementById('user-modal')
  let editingId = null // null=新增；数字=编辑；0/admin 不可编辑

  // 列宽拖拽 + 记忆（类似 Excel，刷新/重进后保留用户设置）
  initColResize('userTbl',
    ['id', 'username', 'name', 'role', 'phone', 'remark', 'createdAt', 'op'],
    { id: 56, username: 110, name: 90, role: 70, phone: 110, remark: 150, createdAt: 130, op: 140 },
    'userTbl_colwidths', { lastFixed: 'op' })

  function openModal(user) {
    addHint.textContent = ''
    addHint.style.color = 'var(--no)'
    const userInput = document.getElementById('newUser')
    const passInput = document.getElementById('newPass')
    const roleInput = document.getElementById('newRole')
    if (user) {
      editingId = user.id
      document.getElementById('user-modal-title').textContent = '编辑用户'
      document.getElementById('addUser').textContent = '保存修改'
      userInput.value = user.username
      userInput.disabled = true // 账号不可改
      document.getElementById('newName').value = user.name || ''
      document.getElementById('newPhone').value = user.phone || ''
      document.getElementById('newRemark').value = user.remark || ''
      roleInput.value = user.role || 'user'
      passInput.value = ''
      passInput.placeholder = '留空则不修改密码'
    } else {
      editingId = null
      document.getElementById('user-modal-title').textContent = '新增用户'
      document.getElementById('addUser').textContent = '创建用户'
      userInput.value = ''
      userInput.disabled = false
      document.getElementById('newName').value = ''
      document.getElementById('newPhone').value = ''
      document.getElementById('newPass').value = ''
      document.getElementById('newRemark').value = ''
      roleInput.value = 'user'
      passInput.placeholder = '至少 6 位'
    }
    modal.classList.add('show')
    userInput.focus()
  }
  function closeModal() { modal.classList.remove('show') }

  document.getElementById('add-btn').addEventListener('click', () => openModal(null))
  document.getElementById('user-modal-close').addEventListener('click', closeModal)
  document.getElementById('user-modal-cancel').addEventListener('click', closeModal)
  modal.addEventListener('click', e => { if (e.target === modal) closeModal() })

  // 权限说明
  const permModal = document.getElementById('perm-modal')
  document.getElementById('perm-btn').addEventListener('click', () => {
    permModal.classList.add('show')
  })
  document.getElementById('perm-modal-close').addEventListener('click', () => permModal.classList.remove('show'))
  document.getElementById('perm-ok').addEventListener('click', () => permModal.classList.remove('show'))
  permModal.addEventListener('click', e => { if (e.target === permModal) permModal.classList.remove('show') })

  async function loadUsers() {
    const j = await api('/api/admin/users')
    if (!j.success) return
    const list = j.data || []
    userBody.innerHTML = ''
    emptyTip.style.display = list.length ? 'none' : 'block'
    for (const u of list) {
      const tr = document.createElement('tr')
      const roleLabel = { admin: '超级管理员', manager: '普通管理员', user: '普通用户' }[u.role] || (u.role || '普通用户')
      const isAdmin = !!u.isAdmin
      const opHtml = isAdmin
        ? '<span class="muted">内置管理员</span>'
        : `<button class="mini" data-edit="${u.id}">编辑</button>
           <button class="mini" data-reset="${u.id}">重置密码</button>
           <button class="mini danger" data-del="${u.id}" data-name="${escapeHtml(u.name || u.username)}">删除</button>`
      tr.innerHTML = `
        <td>${u.id}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.name || '')}</td>
        <td>${escapeHtml(roleLabel)}</td>
        <td>${escapeHtml(u.phone || '')}</td>
        <td>${escapeHtml(u.remark || '')}</td>
        <td>${u.createdAt || ''}</td>
        <td class="ops">${opHtml}</td>`
      userBody.appendChild(tr)
    }
  }

  document.getElementById('addUser').addEventListener('click', async () => {
    const username = document.getElementById('newUser').value.trim()
    const name = document.getElementById('newName').value.trim()
    const phone = document.getElementById('newPhone').value.trim()
    const password = document.getElementById('newPass').value
    const remark = document.getElementById('newRemark').value.trim()
    const role = document.getElementById('newRole').value
    addHint.textContent = ''
    if (!username) { addHint.textContent = '请填写账号'; return }
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) { addHint.textContent = '手机号格式不正确'; return }
    if (editingId) {
      // 编辑
      if (password && password.length < 6) { addHint.textContent = '新密码至少 6 位'; return }
      const j = await api('/api/admin/users/' + editingId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, password, remark, role })
      })
      if (j.success) { addHint.style.color = 'var(--ok)'; addHint.textContent = '已保存'; closeModal(); loadUsers() }
      else { addHint.style.color = 'var(--no)'; addHint.textContent = j.message || '保存失败' }
    } else {
      // 新增
      if (!password) { addHint.textContent = '请填写初始密码'; return }
      if (password.length < 6) { addHint.textContent = '初始密码至少 6 位'; return }
      const j = await api('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, name, phone, password, remark, role })
      })
      if (j.success) { addHint.style.color = 'var(--ok)'; addHint.textContent = '已创建（ID：' + (j.id || '') + '）'; closeModal(); loadUsers() }
      else { addHint.style.color = 'var(--no)'; addHint.textContent = j.message || '创建失败' }
    }
  })

  userBody.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit]')
    const resetBtn = e.target.closest('[data-reset]')
    const delBtn = e.target.closest('[data-del]')
    if (editBtn) {
      const id = Number(editBtn.getAttribute('data-edit'))
      const j = await api('/api/admin/users/' + id)
      const u = j.data || {}
      openModal({ id, username: u.username, name: u.name, phone: u.phone, remark: u.remark, role: u.role })
    } else if (resetBtn) {
      const id = resetBtn.getAttribute('data-reset')
      const pw = prompt('请输入新密码（至少 6 位）')
      if (!pw) return
      if (pw.length < 6) { alert('密码至少 6 位'); return }
      const j = await api('/api/admin/users/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: Number(id), password: pw })
      })
      alert(j.success ? '密码已重置，该用户需重新登录' : (j.message || '失败'))
      if (j.success) loadUsers()
    } else if (delBtn) {
      const id = delBtn.getAttribute('data-del')
      const name = delBtn.getAttribute('data-name')
      if (!confirm('确定删除用户「' + name + '」？该用户将被强制下线。')) return
      const j = await api('/api/admin/users/' + id, { method: 'DELETE' })
      alert(j.success ? '已删除' : (j.message || '失败'))
      if (j.success) loadUsers()
    }
  })

  // 在线设备面板
  const onlineModal = document.getElementById('online-modal')
  const onlineList = document.getElementById('onlineList')
  const onlineEmpty = document.getElementById('onlineEmpty')
  const onlineCount = document.getElementById('onlineCount')
  const onlineMax = document.getElementById('onlineMax')
  document.getElementById('online-btn').addEventListener('click', () => { onlineModal.classList.add('show'); loadOnline() })
  document.getElementById('online-modal-close').addEventListener('click', () => onlineModal.classList.remove('show'))
  document.getElementById('online-ok').addEventListener('click', () => onlineModal.classList.remove('show'))
  document.getElementById('online-refresh').addEventListener('click', loadOnline)
  onlineModal.addEventListener('click', e => { if (e.target === onlineModal) onlineModal.classList.remove('show') })

  async function loadOnline() {
    try {
      const r = await api('admin/user-sessions')
      if (!r || !r.success) return
      const sessions = r.data && r.data.sessions ? r.data.sessions : []
      const max = (r.data && r.data.maxDevices) || 3
      onlineMax.textContent = max
      onlineCount.textContent = sessions.length
      onlineEmpty.style.display = sessions.length ? 'none' : 'block'
      // 按账号分组
      const byUser = {}
      sessions.forEach(s => { (byUser[s.username] = byUser[s.username] || []).push(s) })
      onlineList.innerHTML = Object.keys(byUser).map(username => {
        const items = byUser[username].map(s => `
          <div class="online-item">
            <div class="online-main">
              <span class="online-device">${escapeHtml(s.device)}</span>
              <span class="online-ip">${escapeHtml(s.ip || '未知IP')}</span>
            </div>
            <div class="online-sub">登录时间：${escapeHtml(s.loginAt || '-')}　UA：${escapeHtml(s.ua || '-')}</div>
            <button class="btn danger sm" data-token="${escapeHtml(s.token)}">强制下线</button>
          </div>`).join('')
        return `<div class="online-group"><div class="online-group-title">${escapeHtml(username)}（${byUser[username].length}/${max}）</div>${items}</div>`
      }).join('')
    } catch (e) { /* ignore */ }
  }

  onlineList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-token]')
    if (!btn) return
    if (!confirm('确定强制下线该设备？')) return
    const r = await api('admin/user-sessions/' + encodeURIComponent(btn.dataset.token), { method: 'DELETE' })
    if (r && r.success) loadOnline()
    else alert((r && r.message) || '操作失败')
  })

  loadUsers()
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}
