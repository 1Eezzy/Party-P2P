// Navegação e visão geral: todo conteúdo deriva da sessão P2P atual.
const iconPaths = {
  home: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0Z"/><path d="M8 9h8M8 13h5"/>',
  voice: '<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/>',
  members: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  settings: '<path d="m9 3-1 3-3 1-2 3 2 2-1 4 3 2 3-1 3 3 3-1 1-3 4-1v-4l-3-1-1-4-4-1Z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  leave: '<path d="M5 15v4H2v-6c5-5 15-5 20 0v6h-3v-4l-4-2H9Z"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 22h8m-4-5v5"/>',
  hash: '<path d="m9 3-2 18M17 3l-2 18M3 8h18M2 16h18"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.chat}</svg>`;
const workspaceTabs = [ ['home','Início'], ['chat','Conversas'], ['voice','Salas de voz'], ['members','Membros'], ['activity','Atividade'] ];
let workspaceView = 'home';
let workspaceQuery = '';
$('#rail').innerHTML = `<button class="rail-logo" data-view="home" title="Party · Início" aria-label="Party · Início">${icon('activity')}</button><div class="rail-links">${workspaceTabs.map(([id,label]) => `<button data-view="${id}" title="${label}" aria-label="${label}">${icon(id)}<span>${label}</span></button>`).join('')}</div><button class="rail-settings" data-workspace-settings="profile" title="Configurações" aria-label="Configurações">${icon('settings')}</button><span class="rail-version">P2P</span>`;
$('#search-icon').innerHTML = icon('search');
$('#top-profile').onclick = () => openSettings('profile');
$('#workspace-search').oninput = e => { workspaceQuery = e.target.value.trim().toLocaleLowerCase('pt-BR'); renderWorkspace(); };
document.addEventListener('keydown', e => {
  if (e.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) && !$('#dlg').open && !$('#app').hidden) { e.preventDefault(); $('#workspace-search').focus(); }
});
$('#app').addEventListener('click', e => {
  const view = e.target.closest('[data-view]');
  if (view) setWorkspaceView(view.dataset.view);
  const settings = e.target.closest('[data-workspace-settings]');
  if (settings) openSettings(settings.dataset.workspaceSettings);
  const channel = e.target.closest('[data-workspace-channel]');
  if (channel) { open(channel.dataset.workspaceChannel); if (convs.get(channel.dataset.workspaceChannel)?.type === 'voice') joinVoice(channel.dataset.workspaceChannel); }
  const member = e.target.closest('[data-workspace-member]');
  if (member) open(dmConv(member.dataset.workspaceMember).id);
  const call = e.target.closest('[data-call-action]');
  if (call?.dataset.callAction === 'mute') $('#bm').click();
  if (call?.dataset.callAction === 'leave') leaveVoice();
  if (call?.dataset.callAction === 'open' && S.voice) open(S.voice);
});
function setWorkspaceView(view) {
  workspaceQuery = ''; $('#workspace-search').value = '';
  workspaceView = workspaceTabs.some(([id]) => id === view) ? view : 'home';
  renderWorkspace();
}
function renderWorkspace() {
  $('#app').dataset.view = workspaceView;
  $('#workspace-title').textContent = workspaceTabs.find(([id]) => id === workspaceView)?.[1] || 'Início';
  document.querySelectorAll('#rail [data-view]').forEach(b => {
    b.classList.toggle('active', b.dataset.view === workspaceView);
    if (b.dataset.view === workspaceView) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#top-profile').innerHTML = `${avatarIcon(S.nick || '?', S.avatar)}<span><strong>${esc(S.nick || 'Meu perfil')}</strong><small>${esc(S.party || 'Sua party')}</small></span>`;
  $('#global-call').hidden = !S.voice;
  $('#global-call').innerHTML = S.voice ? `<button data-call-action="open" title="Voltar à chamada">${icon('voice')}<span>Na voz</span></button><button data-call-action="mute" aria-label="${S.muted || S.deaf ? 'Ativar' : 'Silenciar'} microfone" aria-pressed="${S.muted || S.deaf}" title="${S.muted || S.deaf ? 'Microfone silenciado' : 'Silenciar microfone'}">${icon('mic')}</button><button data-call-action="leave" title="Sair da voz" aria-label="Sair da voz">${icon('leave')}</button>` : '';
  for (const [id,name] of [['bm','mic'],['bd','voice'],['bl','leave'],['audio-settings','settings'],['settings','settings']]) if ($('#'+id)) $('#'+id).innerHTML = icon(name);
  $('#bm').setAttribute('aria-pressed', String(S.muted || S.deaf));
  $('#bd').setAttribute('aria-pressed', String(S.deaf));
  const share = $('[data-share]'); if (share) share.innerHTML = `${icon('screen')} Compartilhar tela`;
  const heading = $('#head h2'), current = convs.get(S.cur);
  if (heading && current) heading.innerHTML = `${icon(current.type === 'text' ? 'hash' : current.type === 'voice' ? 'voice' : current.type === 'group' ? 'members' : 'chat')} ${esc(title(current))}`;
  document.querySelectorAll('#side .it u').forEach(el => { const type = convs.get(el.closest('[data-c]')?.dataset.c)?.type; el.innerHTML = icon(type === 'text' ? 'hash' : type === 'group' ? 'members' : 'voice'); });
  const page = $('#workspace-page');
  const channels = [...convs.values()].filter(c => ['text','voice'].includes(c.type) && canAccess(c));
  const people = [{id:S.id,nick:S.nick,avatar:S.avatar,voice:S.voice,self:true}, ...peers.values()];
  const matches = name => !workspaceQuery || String(name).toLocaleLowerCase('pt-BR').includes(workspaceQuery);
  const filtered = channels.filter(c=>matches(c.name));
  const members = people.filter(p=>matches(p.nick));
  const count = c => people.filter(p=>p.voice === c.id).length;
  const channelCards = list => list.map(c => `<button class="space-card" data-workspace-channel="${esc(c.id)}"><span class="space-card-icon">${icon(c.type === 'voice' ? 'voice':'hash')}</span><strong>${esc(c.name)}</strong><small>${c.type === 'voice' ? `${count(c)} na sala · Entrar na voz` : `${c.msgs.length} mensagens · Abrir conversa`}</small><span class="card-arrow">${icon('arrow')}</span></button>`).join('') || '<p class="panel-empty">Nenhuma sala encontrada.</p>';
  const memberRows = list => list.map(p => `<button class="person-row" ${p.self ? 'data-workspace-settings="profile"' : `data-workspace-member="${esc(p.id)}"`}><span class="person-avatar" data-u="${esc(p.id)}">${avatarIcon(p.nick || '?',p.avatar)}</span><span><strong>${esc(p.nick || 'Você')}${p.self ? ' <small>(você)</small>' : ''}</strong><small>${p.voice ? esc(convs.get(p.voice)?.name || 'Em chamada') : 'Disponível'}</small></span><em class="presence-dot"></em></button>`).join('') || '<p class="panel-empty">Ninguém encontrado.</p>';
  const recent = [...convs.values()].filter(c=>canAccess(c)).flatMap(c=>c.msgs.slice(-8).map(m=>({c,m}))).filter(({c,m})=>matches(c.name || title(c)) || matches(m.n) || matches(m.text)).sort((a,b)=>b.m.ts-a.m.ts).slice(0,workspaceView === 'activity' ? 30 : 5);
  const activityRows = recent.map(({c,m})=>`<button class="activity-row" data-workspace-channel="${esc(c.id)}"><span class="activity-symbol">${icon(c.type === 'voice' ? 'voice' : 'chat')}</span><span><strong>${esc(m.n)} <small>em ${esc(title(c))}</small></strong><p>${esc(m.text)}</p></span><time>${new Date(m.ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</time></button>`).join('') || '<div class="quiet-state">'+icon('activity')+'<strong>Tudo tranquilo por aqui.</strong><p>As mensagens da party aparecem aqui conforme a conversa acontece.</p></div>';
  const greeting = `<div class="page-heading"><div><span class="eyebrow">SEU ESPAÇO. SUA GALERA.</span><h1>${workspaceView === 'home' ? `Bom te ver, <span>${esc(S.nick || 'você')}.</span>` : ({voice:'Encontre sua conversa.',members:'Sua party, reunida.',activity:'O que está rolando.'}[workspaceView] || 'Resultados da busca')}</h1><p>${workspaceView === 'home' ? 'Entre na sala. Coloque o papo em dia. Fique à vontade.' : ({voice:'Escolha uma sala para falar com a galera.',members:'Abra uma conversa ou encontre quem está na voz.',activity:'Acompanhe as mensagens mais recentes das suas conversas.'}[workspaceView] || 'Canais e pessoas da sua party.')}</p></div><span class="session-badge"><em></em>${esc(S.party || 'Party')}</span></div>`;
  $('#app').classList.toggle('searching', workspaceView === 'chat' && !!workspaceQuery);
  if (workspaceView === 'chat' && !workspaceQuery) { page.hidden = true; return; }
  page.hidden = false;
  if (workspaceView === 'voice') page.innerHTML = greeting + `<div class="panel section-panel"><div class="panel-heading"><h2>Salas de voz</h2><span>${filtered.filter(c=>c.type==='voice').length} salas</span></div><div class="space-grid">${channelCards(filtered.filter(c=>c.type==='voice'))}</div></div><div class="audio-callout">${icon('mic')}<div><strong>Entre com o áudio pronto.</strong><p>Escolha seu microfone e teste o som antes de chamar a galera.</p></div><button data-workspace-settings="audio">Configurar áudio ${icon('arrow')}</button></div>`;
  else if (workspaceView === 'members') page.innerHTML = greeting + `<div class="panel section-panel"><div class="panel-heading"><h2>Membros online</h2><span>${members.length} pessoas</span></div><div class="members-grid">${memberRows(members)}</div></div>`;
  else if (workspaceView === 'activity') page.innerHTML = greeting + `<div class="panel section-panel"><div class="panel-heading"><h2>Últimas mensagens</h2><span>Da sua sessão</span></div>${activityRows}</div>`;
  else page.innerHTML = greeting + `<div class="overview-grid"><div class="overview-main"><div class="summary-grid"><article class="panel summary-card"><span class="eyebrow">NA PARTY</span><strong>${people.length.toString().padStart(2,'0')}<small>online agora</small></strong><div class="avatar-stack">${people.slice(0,6).map(p=>avatarIcon(p.nick || '?',p.avatar)).join('')}<span>Conectados, de perto.</span></div><div class="summary-line"></div></article><article class="panel summary-card"><span class="eyebrow">SUA CONEXÃO</span><strong id="overview-latency">—<small>aguardando leitura</small></strong><p id="overview-network-note">${peers.size ? 'Medindo a conexão com a party.' : 'A leitura começa quando alguém entrar.'}</p><div class="network-decoration"><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b></div></article></div><section class="panel"><div class="panel-heading"><h2>Seus espaços</h2><button data-view="voice">Ver salas ${icon('arrow')}</button></div><div class="space-grid">${channelCards(filtered)}</div></section><section class="panel"><div class="panel-heading"><h2>Atividade recente</h2><button data-view="activity">Ver tudo ${icon('arrow')}</button></div>${activityRows}</section></div><aside class="overview-aside"><section class="panel"><div class="panel-heading"><h2>Sua galera</h2><span>${people.length}</span></div>${memberRows(members)}<button class="panel-footer-link" data-view="members">Todos os membros ${icon('arrow')}</button></section><section class="panel audio-quick"><span class="space-card-icon">${icon('mic')}</span><h2>Pronto para falar?</h2><p>Um bom papo começa com um áudio limpo.</p><button data-workspace-settings="audio">Testar meu microfone ${icon('arrow')}</button></section></aside></div>`;
  syncWorkspaceNetwork();
  paint();
}
function syncWorkspaceNetwork() {
  const meter = $('#overview-latency'); if (!meter) return;
  const label = $('#connection-label').textContent;
  const value = label.match(/^(\d+) ms/);
  meter.innerHTML = value ? `${value[1]}<small>ms de latência</small>` : '—<small>sem leitura</small>';
  $('#overview-network-note').textContent = label;
  meter.closest('.summary-card').dataset.quality = $('#connection').dataset.quality || 'unknown';
}
