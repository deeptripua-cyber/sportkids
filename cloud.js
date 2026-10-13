/* SportKids cloud connection: auth, protected player records and private photos. */
(() => {
  const config = window.SPORTKIDS_SUPABASE;
  if (!config?.url || !config?.publishableKey || !window.supabase) return;

  const db = window.supabase.createClient(config.url, config.publishableKey);
  let dataDb = db;
  let user = null;
  let organizationId = null;
  let canManage = false;
  let syncTimer = null;
  let syncing = false;

  const byId = id => document.getElementById(id);
  const message = text => { ['authMessage', 'cloudStatus'].forEach(id => { const node = byId(id); if (node) node.textContent = text || ''; }); };
  const setOpen = open => byId('authDialog')?.classList.toggle('open', open);
  const setButton = () => {
    const button = byId('authButton');
    if (!button) return;
    button.textContent = user ? 'Вийти' : 'Увійти';
    button.classList.toggle('signed-in', Boolean(user));
  };
  const localSnapshot = () => ({ players: window.SportKidsApp?.getPlayers?.() || [], activeId: window.SportKidsApp?.getActiveId?.() });

  async function signedPhoto(path) {
    if (!path) return '';
    const { data } = await dataDb.storage.from('player-photos').createSignedUrl(path, 3600);
    return data?.signedUrl || '';
  }

  async function loadWorkspace() {
    if (!user || !window.SportKidsApp) return;
    const [membershipResult, playersResult] = await Promise.all([
      dataDb.from('organization_members').select('organization_id, role').eq('user_id', user.id),
      dataDb.from('players').select('id, organization_id, user_id, full_name, position, avatar_path, app_state, created_at').order('created_at')
    ]);
    const memberships = membershipResult.data;
    const remotePlayers = playersResult.data;
    if (membershipResult.error || playersResult.error) { message(`Не вдалося завантажити дані: ${(membershipResult.error || playersResult.error).message}`); return; }
    let member = memberships?.[0];
    if (!member) {
      const { data: workspaceId, error: workspaceError } = await dataDb.rpc('ensure_coach_workspace');
      if (workspaceError) { message(`Не вдалося підготувати кабінет тренера: ${workspaceError.message}`); return; }
      member = { organization_id: workspaceId, role: 'owner' };
    }
    organizationId = member.organization_id;
    canManage = true;
    if (remotePlayers?.length) {
      const hydrated = await Promise.all(remotePlayers.map(async row => {
        const state = row.app_state && typeof row.app_state === 'object' ? row.app_state : {};
        return {
          ...state,
          id: state.id || `p-${row.id}`,
          cloudId: row.id,
          name: row.full_name || state.name || '',
          position: row.position || state.position || '',
          photo: await signedPhoto(row.avatar_path),
          history: state.history || {}, tests: state.tests || [], challenges: state.challenges || {},
          period: state.period || { month: 'Січень', week: 'Тиждень 1' }, goal: state.goal || null
        };
      }));
      window.SportKidsApp.replaceCloudPlayers(hydrated, localStorage.getItem('sportkids-active'));
      message(canManage ? 'Дані команди синхронізовано.' : 'Ви переглядаєте доступний профіль.');
      setOpen(false);
    } else {
      const snapshot = localSnapshot();
      const saved = snapshot.players.length ? await syncNow(snapshot.players) : true;
      if (saved) message('Кабінет тренера готовий. Дані збережено у хмарі.');
      setOpen(false);
    }
  }

  async function dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    return response.blob();
  }

  async function uploadPhoto(player) {
    if (!player.photo?.startsWith('data:image/') || !player.cloudId) return;
    const path = `${player.cloudId}/avatar.jpg`;
    const blob = await dataUrlToBlob(player.photo);
    const { error } = await dataDb.storage.from('player-photos').upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
    if (error) throw error;
    await dataDb.from('players').update({ avatar_path: path }).eq('id', player.cloudId);
    player.photo = await signedPhoto(path);
  }

  function cloudState(player) {
    const state = { ...player };
    delete state.cloudId;
    delete state.photo;
    return state;
  }

  async function syncNow(players) {
    if (!user || !organizationId || !canManage || syncing) return;
    syncing = true;
    try {
      for (const player of players) {
        const payload = { full_name: player.name || 'Новий гравець', position: player.position || null, app_state: cloudState(player) };
        if (!player.cloudId) {
          const { data, error } = await dataDb.from('players').insert({ ...payload, organization_id: organizationId }).select('id').single();
          if (error) throw error;
          player.cloudId = data.id;
        } else {
          const { error } = await dataDb.from('players').update(payload).eq('id', player.cloudId);
          if (error) throw error;
        }
        await uploadPhoto(player);
      }
      localStorage.setItem('sportkids-players', JSON.stringify(players));
      message('Зміни збережено у хмарі.');
      return true;
    } catch (error) {
      message(`Зміни лишилися у цьому браузері: ${error.message}`);
      return false;
    } finally { syncing = false; }
  }

  function queueSync(players) {
    if (!canManage || !organizationId) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(players), 700);
  }

  async function submitAuth(event) {
    event.preventDefault();
    const email = byId('authEmail')?.value.trim();
    const password = byId('authPassword')?.value;
    const fullName = byId('authName')?.value.trim();
    const mode = byId('authMode')?.value || 'signin';
    if (!email || !password) return;
    message('Зачекайте…');
    let result;
    try {
      result = await Promise.race([
        mode === 'signup'
          ? db.auth.signUp({ email, password, options: { data: { full_name: fullName || '' } } })
          : db.auth.signInWithPassword({ email, password }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Сервер не відповів за 15 секунд. Оновіть сторінку та спробуйте ще раз.')), 15000))
      ]);
    } catch (error) { message(error.message || 'Не вдалося виконати вхід. Спробуйте ще раз.'); return; }
    if (result.error) { message(result.error.message); return; }
    message(mode === 'signup' ? 'Перевірте email і підтвердьте реєстрацію, потім увійдіть.' : 'Вхід виконано.');
    if (result.data.session) {
      await new Promise(resolve => setTimeout(resolve, 150));
      await setUser();
    }
  }

  async function setUser() {
    const { data: { session } } = await db.auth.getSession();
    user = session?.user || null;
    dataDb = session
      ? window.supabase.createClient(config.url, config.publishableKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          accessToken: () => Promise.resolve(session.access_token)
        })
      : db;
    organizationId = null;
    canManage = false;
    setButton();
    if (user) await loadWorkspace();
    else message('Увійдіть тренерським email і паролем, щоб відкрити кабінет.');
  }

  function bindUi() {
    byId('authButton')?.addEventListener('click', async () => {
      if (user) { await db.auth.signOut(); return; }
      setOpen(true);
    });
    byId('authClose')?.addEventListener('click', () => setOpen(false));
    byId('authForm')?.addEventListener('submit', submitAuth);
    byId('authMode')?.addEventListener('change', event => {
      const signup = event.target.value === 'signup';
      byId('authNameRow')?.classList.toggle('hidden', !signup);
      byId('authSubmit').textContent = signup ? 'Створити акаунт' : 'Увійти';
    });
  }

  window.SportKidsCloud = { start: async () => {
    bindUi();
    const { data } = await db.auth.getSession();
    await setUser();
    db.auth.onAuthStateChange(() => { setTimeout(() => setUser(), 150); });
  }, queueSync, db };
})();
