'use strict';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function one(q){const r=await q;if(r.error)throw r.error;return r.data;}
async function pages(make,max=10000){const out=[];for(let n=0;n<=max;n+=500){const rows=await one(make().range(n,n+499));out.push(...rows);if(out.length>max)throw new Error('Too many records. Select a recording.');if(rows.length<500)return out;}throw new Error('Record limit exceeded');}
function createData(db){
 async function sourceFor(req,id){if(!UUID.test(id)||!req.devices.length)return null;return one(db.from('video_sources').select('*').eq('id',id).in('device_id',req.devices).maybeSingle());}
 async function eventFor(req,id){if(!UUID.test(id)||!req.devices.length)return null;return one(db.from('cctv_events').select('*').eq('id',id).in('device_id',req.devices).maybeSingle());}
 async function buildBootstrap(req){
 const tz=req.user.timezone||'Asia/Karachi',fmt=o=>new Intl.DateTimeFormat('en-US',{timeZone:tz,...o});
 const f12=fmt({hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}),f24=fmt({hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}),fDay=fmt({year:'numeric',month:'2-digit',day:'2-digit'}),fLong=fmt({month:'short',day:'2-digit',year:'numeric'}),fShort=fmt({month:'short',day:'2-digit'});
 const t12=d=>d?f12.format(new Date(d)):'-',t24=d=>d?f24.format(new Date(d)).replace(/^24/,'00'):'-';
 const isoDay=d=>{const p=Object.fromEntries(fDay.formatToParts(new Date(d)).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;};
 const level=s=>['High','Medium','Low'].includes(s)?s:'Medium',tagClass={High:'badge-red',Medium:'badge-orange',Low:'badge-blue'};
 const selected=req.query.source||'';
 if(selected&&!await sourceFor(req,selected)){const e=new Error('Recording not found or access removed');e.status=404;throw e;}
 let events=[],alerts=[],sources=[],steps=[];
 if(req.devices.length){
 [events,alerts,sources]=await Promise.all([
 pages(()=>{let q=db.from('cctv_events').select('*').in('device_id',req.devices).order('start_time',{ascending:false}).order('id');return selected?q.eq('video_source_id',selected):q;},selected?10000:3000),
 pages(()=>{let q=db.from('cctv_alerts').select(selected?'*,cctv_events!inner(video_source_id)':'*').in('device_id',req.devices).order('alert_time',{ascending:false}).order('id');return selected?q.eq('cctv_events.video_source_id',selected):q;},selected?10000:3000),
 pages(()=>{let q=db.from('video_sources').select('id,camera_name,device_id,created_at,recording_start,time_basis,status,duration_sec').in('device_id',req.devices).order('created_at',{ascending:false}).order('id');return selected?q.eq('id',selected):q;})]);
 for(let i=0;i<events.length;i+=150){const ids=events.slice(i,i+150).map(e=>e.id);steps.push(...await pages(()=>db.from('event_timeline').select('*').in('event_id',ids).order('step_time').order('id'),30000));}
 }
 const rules=await one(db.from('rule_configurations').select('*'));
  const src = Object.fromEntries(sources.map((s) => [s.id, s]));
  const evById = Object.fromEntries(events.map((e) => [e.id, e]));
  const cam = (e) => (e && (e.camera_id || (src[e.video_source_id] || {}).camera_name)) || "Camera 01";

  const ev = events.map((e, i) => ({
    id: e.id, n: events.length - i, code: e.event_code, name: e.event_name, type: e.event_type, rule: e.rule_triggered,
    personId: e.person_id || "-", vehicleId: e.vehicle_id || "-",
    start: t12(e.start_time), end: e.end_time ? t12(e.end_time) : "-", date: isoDay(e.start_time),
    camera: cam(e), status: e.status, severity: level(e.alert_level), description: e.description || "", notes: e.notes || "",
    videoSourceId: e.video_source_id || null, videoOffsetSec: e.video_offset_sec == null ? null : Number(e.video_offset_sec),
    startIso: e.start_time, timeBasis: e.time_basis || null,
    duration: Number(e.duration_sec || 0), confidence: e.confidence, clipStatus: e.clip_status, clipPath: e.clip_path,
    hasSnapshot: !!(e.snapshot_object || e.snapshot_path), snapshot: `/api/snapshot/${e.id}`,
  }));

  const al = alerts.map((a, i) => {
    const e = evById[a.event_id];
    return { id: a.id, code: a.alert_code, time: t12(a.alert_time), name: a.alert_title, severity: level(a.alert_level),
      status: a.is_acknowledged ? "Resolved" : "Open", date: isoDay(a.alert_time), camera: cam(e), rule: e ? e.rule_triggered : "-", eventId: a.event_id };
  });

  const tl = steps.filter((s) => evById[s.event_id]).map((s) => {
    const e = evById[s.event_id]; const rawClock = s.step_clock; const clock = rawClock && !/^\d{4}-\d{2}-\d{2}T/.test(rawClock) ? rawClock : t24(rawClock || s.step_time);
    const pid = e.person_id ? `Person #${e.person_id}` : null, vid = e.vehicle_id ? `Vehicle #${e.vehicle_id}` : null;
    return { time: clock, date: fLong.format(new Date(s.step_time)), isoDate: isoDay(s.step_time), eventType: e.event_name, desc: s.description,
      camera: cam(e), tag: `[${pid || vid || e.rule_triggered}]`, tagClass: tagClass[level(e.alert_level)], previewTime: clock,
      boxes: [pid && { type: "person-box", label: pid, text: pid }, vid && { type: "vehicle-box", label: vid, text: vid }].filter(Boolean),
      relatedTitle: e.event_name, relatedTime: `${t24(e.start_time)} - ${e.end_time ? t24(e.end_time) : "…"}`, severity: level(e.alert_level),
      metadata: [pid, vid].filter(Boolean).join(" / ") || e.rule_triggered, eventId: e.id, order: s.step_order };
  });

  // daily chart: last 7 days that exist in the data window
  const today = new Date(selected && events[0]?.start_time || Date.now()); const days = [];
  for (let i = 6; i >= 0; i--) days.push(new Date(today.getTime() - i * 864e5));
  const keys = days.map(isoDay);
  const daily = { labels: days.map((d) => fShort.format(d)), total: keys.map((k) => ev.filter((e) => e.date === k).length),
    relevant: keys.map((k) => ev.filter((e) => e.date === k && e.severity !== "Low").length) };

  const week = selected ? ev : ev.filter((e) => keys.includes(e.date));
  const metrics = {
    totalEvents: week.length,
    relevant: week.filter((e) => e.severity === "High" || e.severity === "Medium").length,
    activeAlerts: al.filter((a) => a.status === "Open").length,
    videosAnalyzed: sources.length,
    investigations: ev.filter((e) => e.status === "Active" || e.status === "Open").length,
  };

  const inv = ev.map((e) => ({ id: e.code, name: e.name, time: e.start, date: e.date, camera: e.camera, status: e.status, eventId: e.id, severity: e.severity }));
  const cameras = [...new Set(ev.map((e) => e.camera).concat(sources.map((s) => s.camera_name)))].filter(Boolean);
  return { ok: true, tz: tz, metrics, daily, events: ev, alerts: al, timeline: tl, investigations: inv, cameras,
    rules: rules.map((r) => ({ name: r.rule_name, enabled: r.is_enabled, window: r.time_window, params: r.parameters })), generatedAt: new Date().toISOString() };
}
 return {sourceFor,eventFor,buildBootstrap};
}
module.exports={createData,UUID,one,pages};
