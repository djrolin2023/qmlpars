function initUsers() {
  const userBody = document.getElementById('userBody')
  const emptyTip = document.getElementById('emptyTip')
  const addHint = document.getElementById('addHint')
  const modal = document.getElementById('user-modal')

  function openModal() {
    addHint.textContent = ''
    addHint.style.color = 'var(--no)'
    document.getElementById('newUser').value = ''
    document.getElementById('newName').value = ''
    document.getElementById('newPhone').value = ''
    document.getElementById('newPass').value = ''
    document.getElementById('newRemark').value = ''
    modal.classList.add('show')
    document.getElementById('newUser').focus()
  }
  function closeModal() { modal.classList.remove('show') }

  document.getElementById('add-btn').addEventListener('click', openModal)
  document.getElementById('user-modal-close').addEventListener('click', closeModal)
  document.getElementById('user-modal-cancel').addEventListener('click', closeModal)
  modal.addEventListener('click', e => { if (e.target === modal) closeModal() })

  async function loadUsers() {
    const j = await api('/api/admin/users')
    if (!j.success) return
    const list = j.data || []
    userBody.innerHTML = ''
    emptyTip.style.display = list.length ? 'none' : 'block'
    for (const u of list) {
      const tr = document.createElement('tr')
      tr.innerHTML = `
        <td>${u.id}</td>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.name || '')}</td>
        <td>${escapeHtml(u.phone || '')}</td>
        <td>${escapeHtml(u.remark || '')}</td>
        <td>${u.createdAt || ''}</td>
        <td class="ops">
          <button class="mini" data-reset="${u.id}">重置密码</button>
          <button class="mini danger" data-del="${u.id}" data-name="${escapeHtml(u.name || u.username)}">删除</button>
        </td>`
      userBody.appendChild(tr)
    }
  }

  document.getElementById('addUser').addEventListener('click', async () => {
    const username = document.getElementById('newUser').value.trim()
    const name = document.getElementById('newName').value.trim()
    const phone = document.getElementById('newPhone').value.trim()
    const password = document.getElementById('newPass').value
    const remark = document.getElementById('newRemark').value.trim()
    addHint.textContent = ''
    if (!username || !password) { addHint.textContent = '请填写账号和密码'; return }
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) { addHint.textContent = '手机号格式不正确'; return }
    const j = await api('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, name, phone, password, remark })
    })
    if (j.success) {
      addHint.style.color = 'var(--ok)'
      addHint.textContent = '已创建（ID：' + (j.id || '') + '）'
      closeModal()
      loadUsers()
    } else {
      addHint.textContent = j.message
      addHint.style.color = 'var(--no)'
    }
  })

  userBody.addEventListener('click', async (e) => {
    const resetBtn = e.target.closest('[data-reset]')
    const delBtn = e.target.closest('[data-del]')
    if (resetBtn) {
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

  loadUsers()
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}
