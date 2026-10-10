// Run: node_modules/.bin/electron tests/smoke.cjs
// Uses isolated sessions and synthetic microphones; never touches real profiles.
const { app, BrowserWindow, contextBridge } = require('electron');
if (process.type === 'renderer') {
  contextBridge.exposeInMainWorld('bridge', {
    persistence: { load: async () => ({}), saveRecent: async () => {}, saveProfile: async () => {} },
    profile: { photo: async () => null }, update: { onProgress: () => {} },
  });
} else {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const { startServer } = require('../server');
  const output = path.join(os.tmpdir(), 'party-p2p-smoke');
  fs.mkdirSync(output, { recursive: true });
  app.setPath('userData', path.join(output, 'user-data'));
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  const run = (w, code) => w.webContents.executeJavaScript(code, true);
  const capture = async w => { await w.webContents.capturePage(); await new Promise(r=>setTimeout(r,250)); return w.webContents.capturePage(); };
  const waitFor = async (w, code) => {
    for (let i = 0; i < 100; i++) {
      if (await run(w, code)) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw Error('Timed out: ' + code);
  };
  app.whenReady().then(async () => {
    const windows = [];
    try {
      await startServer({ port: 17779, name: 'After Hours', password: '' });
      for (const nick of ['Lucas', 'Eezzy']) {
        const w = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { preload: __filename, sandbox: false, partition: nick, backgroundThrottling: false } });
        windows.push(w);
        await w.loadFile(path.join(__dirname, '..', 'index.html'));
        await run(w, `S.nick=${JSON.stringify(nick)}; ac=new AudioContext(); ac.resume(); connect('127.0.0.1:17779',S.nick,'');`);
        await waitFor(w, '!!S.id');
      }
      const [a,b] = windows;
      await waitFor(a, '[...peers.values()].some(p=>p.dc?.readyState === "open")');
      assert.equal(await run(a, 'workspaceView'), 'home');
      assert.equal(await run(a, 'document.querySelectorAll(".space-card").length'), 2);
      await run(a, 'document.fonts.ready.then(()=>true)');
      assert.equal(await run(a, 'document.fonts.check("13px Manrope")'), true);
      await run(a, 'document.querySelector("[data-view=members]").click()');
      assert.equal(await run(a, 'document.querySelectorAll(".members-grid .person-row").length'), 2);
      await run(a, 'document.querySelector("#workspace-search").value="Eezzy"; document.querySelector("#workspace-search").dispatchEvent(new Event("input"))');
      assert.equal(await run(a, 'document.querySelectorAll(".members-grid .person-row").length'), 1);
      await run(a, 'document.querySelector("[data-workspace-member]").click()');
      assert.equal(await run(a, 'workspaceView'), 'chat');
      await run(a, "setWorkspaceView('voice')");
      assert.equal(await run(a, 'document.querySelectorAll(".space-card").length'), 1);
      await run(a, "setWorkspaceView('activity')");
      assert.equal(await run(a, '!!document.querySelector(".quiet-state")'), true);
      const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=';
      await run(a, `S.avatar=${JSON.stringify(avatar)}; syncProfileAvatar(); render();`);
      await waitFor(b, '[...peers.values()].some(p=>!!p.avatar)');
      await run(a, "joinVoice('c-voz')"); await run(b, "joinVoice('c-voz')");
      await waitFor(a, '[...peers.values()].some(p=>p.voice === S.voice)');
      await run(a, "open('c-voz')");
      assert.equal(await run(a, 'document.querySelectorAll(".voice-card").length'), 2);
      await run(a, 'sampleNetwork()');
      await waitFor(a, 'document.querySelector("#connection").dataset.quality === "good"');
      await waitFor(a, 'speaking.size > 0');
      await run(a, 'S.muted=true; apply(); announce();');
      await waitFor(a, '!speaking.has(S.id)');
      await run(a, 'S.muted=false; apply(); announce();');
      await run(a, "openSettings('audio')");
      await waitFor(a, 'document.querySelector("#mic-device").options.length > 1');
      await run(a, 'document.querySelector("#test-mic").click()');
      await waitFor(a, '!!micTest');
      await run(a, 'window.testTrack=micTest.stream.getAudioTracks()[0]; document.querySelector("#dlg").close()');
      await waitFor(a, 'micTest === null && window.testTrack.readyState === "ended"');
      assert.equal(await run(a, 'S.mic.readyState'), 'live');
      await run(a, "openSettings('audio')");
      await run(a, 'window.oldMic=S.mic; document.querySelector("#mic-device").value="default"; document.querySelector("#mic-device").dispatchEvent(new Event("change"))');
      await waitFor(a, '!changingMic');
      assert.equal(await run(a, 'window.oldMic.readyState'), 'ended');
      await run(a, `window.realCapture=captureMic; captureMic=async()=>{throw new Error('Permission denied')}; document.querySelector('#test-mic').click()`);
      await waitFor(a, 'document.querySelector("#mic-status").textContent.includes("Sem acesso")');
      assert.equal(await run(a, 'micTest'), null);
      await run(a, 'captureMic=window.realCapture; void 0');
      await run(a, `window.networkPeer=[...peers.values()][0]; window.realStats=window.networkPeer.pc.getStats.bind(window.networkPeer.pc); window.networkPeer.pc.getStats=async()=>new Map([['pair',{type:'candidate-pair',state:'succeeded',nominated:true,currentRoundTripTime:.15}]]); sampleNetwork()`);
      await waitFor(a, 'document.querySelector("#connection").dataset.quality === "fair"');
      await run(a, `window.networkPeer.pc.getStats=async()=>new Map([['pair',{type:'candidate-pair',state:'succeeded',nominated:true,currentRoundTripTime:.25}]]); sampleNetwork()`);
      await waitFor(a, 'document.querySelector("#connection").dataset.quality === "poor"');
      await run(a, 'window.networkPeer.pc.getStats=window.realStats; sampleNetwork()');
      await run(a, 'document.querySelector("#dlg").close()');
      await run(a, `say('A party está pronta. Bora jogar?');`);
      await waitFor(b, 'convs.get("c-voz").msgs.length > 0');
      await new Promise(r=>setTimeout(r,1200));
      fs.writeFileSync(path.join(output, 'voice.png'), (await capture(a)).toPNG());
      await run(a, "openSettings('audio')");
      await new Promise(r=>setTimeout(r,1200));
      fs.writeFileSync(path.join(output, 'audio.png'), (await capture(a)).toPNG());
      await run(a, 'document.querySelector("#dlg").close(); setWorkspaceView("home")');
      await new Promise(r=>setTimeout(r,700));
      fs.writeFileSync(path.join(output, 'home.png'), (await capture(a)).toPNG());
      await run(a, "setWorkspaceView('members')");
      await new Promise(r=>setTimeout(r,500));
      fs.writeFileSync(path.join(output, 'members.png'), (await capture(a)).toPNG());
      assert.equal(await run(a, '!document.querySelector("#global-call").hidden'), true);
      await run(a, 'document.querySelector("[data-call-action=mute]").click()');
      assert.equal(await run(a, 'S.muted'), true);
      await run(a, 'document.querySelector("[data-call-action=mute]").click()');
      a.setSize(900, 700);
      await run(a, "setWorkspaceView('home')");
      await new Promise(r=>setTimeout(r,700));
      assert.equal(await run(a, 'document.querySelector("#workspace-page").scrollWidth <= document.querySelector("#workspace-page").clientWidth'), true);
      fs.writeFileSync(path.join(output, 'compact.png'), (await capture(a)).toPNG());
      await run(a, "open('c-voz')");
      await new Promise(r=>setTimeout(r,700));
      fs.writeFileSync(path.join(output, 'compact-voice.png'), (await capture(a)).toPNG());
      await run(a, 'document.querySelector("#dlg").close(); leaveVoice();');
      assert.equal(await run(a, 'watchers.has(S.id)'), false);
      await run(a, 'S.avatar=null; syncProfileAvatar()');
      await waitFor(b, '[...peers.values()].every(p=>!p.avatar)');
      console.log('PASS: avatar sync, two-peer voice, real RTT, speaking/mute, mic test cleanup, input replacement, messaging, voice cleanup.');
      console.log('Screenshots: ' + output);
      app.exit(0);
    } catch (e) { console.error(e); app.exit(1); }
  });
}
