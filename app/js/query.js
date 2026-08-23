/* ============ 输入查询 ============ */
const PLATE_RE=/^[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-Z][A-Z0-9]{5,6}$/;
async function queryPlate(){
  const input=document.getElementById('qPlate'), err=document.getElementById('qErr');
  const plate=input.value.trim().toUpperCase();
  err.textContent='';
  if(!plate){ err.textContent='请输入车牌号'; return; }
  // 允许完整车牌 或 至少 4 位连续片段（模糊查询）
  if(!PLATE_RE.test(plate) && plate.length<4){ err.textContent='请输入完整车牌，或至少 4 位连续车牌字符（如 mxy5）'; return; }
  showLoading();
  try{
    const r=await userFetch(API+'/api/vehicles/search?plate='+encodeURIComponent(plate));
    const j=await r.json();
    if(j.success&&j.data){
      const fullPlate=(j.data.vehicle&&j.data.vehicle.plateNo)?j.data.vehicle.plateNo:plate;
      showResult(fullPlate,j.data);
    }
    else showNotFound('【<b style="color:var(--txt)">'+esc(plate)+'</b>】暂无数据，<br>请联系管理人员确认是否报备该车辆');
  }catch(e){ err.textContent='查询失败：'+e.message; }
}
