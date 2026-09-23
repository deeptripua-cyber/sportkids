(() => {
  const config = window.SPORTKIDS_SUPABASE;
  if (!config?.url || !config?.publishableKey || !window.supabase) return;

  const authDb = window.supabase.createClient(config.url, config.publishableKey);
  let dataDb = authDb;
  let session = null;
  let mode = null;
  let syncTimer = null;
  let syncChain = Promise.resolve(true);
  let activation = null;
  let activationKey = null;
  let sessionEpoch = 0;
  let currentSessionKey = null;

  const byId = id => document.getElementById(id);
  const playerEmail = login => `${login.trim().toLowerCase()}@login.sportkids.app`;
  const status = text => {
    const node = byId('sessionStatus');
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('is-error', /^(Помилка|Не вдалося)/.test(text));
  };
  const message = (id, text) => { const node = byId(id); if (node) node.textContent = text || ''; };
  const dialog = (id, open) => byId(id)?.classList.toggle('open', open);
  const cacheKey = coachId => `sportkids-players-coach-${coachId}`;
  const activeCacheKey = coachId => `sportkids-active-coach-${coachId}`;
  const isCurrentSession = (epoch, userId) => Boolean(session) && sessionEpoch === epoch && session.user.id === userId;
  const isCurrentCoach = (epoch, userId) => isCurrentSession(epoch, userId) && mode === 'coach';

  function readCoachCache(coachId) {
    try {
      const saved = JSON.parse(localStorage.getItem(cacheKey(coachId)) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch { return []; }
  }

  function cacheCoachPlayers(coachId = session?.user?.id) {
    if (!coachId || !window.SportKidsApp) return;
    try {
      const players = window.SportKidsApp.getPlayers();
      localStorage.setItem(cacheKey(coachId), JSON.stringify(players));
      localStorage.setItem(activeCacheKey(coachId), window.SportKidsApp.getActiveId());
      // The older local copy stays for the demo view, but never gets imported
      // into a different coach account automatically.
      localStorage.setItem('sportkids-players', JSON.stringify(players));
    } catch {
      // Cloud saving still works if a browser blocks or fills local storage.
    }
  }

  function readCoachActiveId(coachId) {
    try { return localStorage.getItem(activeCacheKey(coachId)); }
    catch { return null; }
  }

  function setSession(nextSession) {
    const nextKey = nextSession?.access_token || null;
    const sameUser = Boolean(session && nextSession && session.user.id === nextSession.user.id);
    if (nextKey !== currentSessionKey) {
      sessionEpoch += 1;
      currentSessionKey = nextKey;
      // Refreshing a token for the same trainer must not reset the screen that
      // the trainer is currently viewing.
      if (!sameUser) mode = null;
      activation = null;
      activationKey = null;
      clearTimeout(syncTimer);
      syncTimer = null;
      // Work started with an earlier account is never reused for the next one.
      syncChain = Promise.resolve(true);
    }
    session = nextSession || null;
    if (!session) {
      dataDb = authDb;
      return;
    }
    const token = session.access_token;
    dataDb = window.supabase.createClient(config.url, config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      // Capture this token. A later sign-out must not strip the token from an
      // in-flight request for the previous session.
      accessToken: async () => token
    });
  }

  function stateForCloud(player) {
    const state = { ...player };
    delete state.cloudId;
    return state;
  }

  function hydrate(row) {
    const state = row.app_state && typeof row.app_state === 'object' ? row.app_state : {};
    return {
      ...state,
      id: state.id || `p-${row.id}`,
      cloudId: row.id,
      login: row.username || state.login || '',
      name: row.full_name || state.name || '',
      age: row.age ?? state.age ?? '',
      position: row.position || state.position || '',
      history: state.history || {},
      tests: state.tests || [],
      challenges: state.challenges || {},
      period: state.period || { month: 'Січень', week: 'Тиждень 1' },
      goal: state.goal || null
    };
  }

  async function performSync(list, epoch, coachId, db) {
    if (!isCurrentCoach(epoch, coachId)) return false;
    try {
      for (const player of list) {
        if (!isCurrentCoach(epoch, coachId)) return false;
        const payload = {
          coach_id: coachId,
          full_name: player.name || 'Новий гравець',
          age: player.age ? Number(player.age) : null,
          position: player.position || null,
          app_state: stateForCloud(player)
        };
        if (player.cloudId) {
          const { data, error } = await db.from('player_accounts')
            .update(payload)
            .eq('id', player.cloudId)
            .eq('coach_id', coachId)
            .select('id')
            .maybeSingle();
          if (!isCurrentCoach(epoch, coachId)) return false;
          if (error) throw error;
          // RLS can hide an old ID without returning an error. Create a new
          // private record rather than reporting a false successful save.
          if (!data) player.cloudId = null;
        }
        if (!player.cloudId) {
          const { data, error } = await db.from('player_accounts').insert(payload).select('id').single();
          if (!isCurrentCoach(epoch, coachId)) return false;
          if (error) throw error;
          player.cloudId = data.id;
        }
      }
      if (!isCurrentCoach(epoch, coachId)) return false;
      cacheCoachPlayers(coachId);
      status('Збережено у Supabase');
      return true;
    } catch (error) {
      if (isCurrentSession(epoch, coachId)) status(`Помилка збереження: ${error.message}`);
      return false;
    }
  }

  function syncPlayers(list) {
    if (!session || mode !== 'coach') return Promise.resolve(false);
    const epoch = sessionEpoch;
    const coachId = session.user.id;
    const db = dataDb;
    const requestedPlayers = Array.isArray(list) ? [...list] : [];
    // Saving is serialized. A quick click on “Save profile” and then
    // “Create player login” cannot turn into a random false failure.
    const task = syncChain.catch(() => false).then(() => performSync(requestedPlayers, epoch, coachId, db));
    syncChain = task.catch(() => false);
    return task;
  }

  async function loadCoach(epoch) {
    const coachId = session?.user?.id;
    const db = dataDb;
    if (!coachId) return false;
    const { data, error } = await db.from('player_accounts').select('*').eq('coach_id', coachId).order('created_at');
    if (!isCurrentSession(epoch, coachId)) return false;
    if (error) {
      mode = null;
      window.SportKidsApp.setPublicView();
      status(`Помилка завантаження: ${error.message}`);
      return false;
    }

    const openCoachBoard = mode !== 'coach';
    mode = 'coach';
    if (openCoachBoard) window.SportKidsApp.setCoachView();
    if (data.length) {
      window.SportKidsApp.replacePlayers(data.map(hydrate), readCoachActiveId(coachId));
      cacheCoachPlayers(coachId);
    } else {
      const cachedPlayers = readCoachCache(coachId);
      if (cachedPlayers.length) window.SportKidsApp.replacePlayers(cachedPlayers, readCoachActiveId(coachId));
      else window.SportKidsApp.resetToDraft();
    }
    status(`Кабінет тренера · профілів у базі: ${data.length}`);
    return true;
  }

  async function loadPlayer(epoch) {
    const playerId = session?.user?.id;
    const db = dataDb;
    if (!playerId) return false;
    const { data, error } = await db.from('player_accounts').select('*').eq('player_user_id', playerId).maybeSingle();
    if (!isCurrentSession(epoch, playerId)) return false;
    if (error || !data) {
      mode = null;
      window.SportKidsApp.setPublicView();
      status(error ? `Помилка доступу: ${error.message}` : 'Для цього логіна ще не призначено профіль гравця.');
      return false;
    }
    mode = 'player';
    const player = hydrate(data);
    window.SportKidsApp.replacePlayers([player], player.id);
    window.SportKidsApp.setPlayerOnly();
    status(`Профіль гравця: ${data.full_name || data.username}`);
    return true;
  }

  function updateAuthButtons(loggedIn) {
    byId('loginButton').hidden = loggedIn;
    byId('logoutButton').hidden = !loggedIn;
  }

  async function activateSession(nextSession) {
    setSession(nextSession);
    if (!session) {
      mode = null;
      window.SportKidsApp.setPublicView();
      status('Публічна сторінка SportKids');
      updateAuthButtons(false);
      return false;
    }

    const epoch = sessionEpoch;
    const key = session.access_token;
    if (activation && activationKey === key) return activation;
    const task = (async () => {
      const ready = session.user.user_metadata?.role === 'player' ? await loadPlayer(epoch) : await loadCoach(epoch);
      if (!isCurrentSession(epoch, session?.user?.id)) return false;
      updateAuthButtons(true);
      return ready;
    })();
    activation = task;
    activationKey = key;
    try { return await task; }
    finally {
      if (activation === task) {
        activation = null;
        activationKey = null;
      }
    }
  }

  async function refreshSession() {
    const { data, error } = await authDb.auth.getSession();
    if (error) { status(`Помилка сесії: ${error.message}`); return false; }
    return activateSession(data.session);
  }

  async function coachLogin(event) {
    event.preventDefault();
    message('accessMessage', 'Вхід…');
    const { data, error } = await authDb.auth.signInWithPassword({
      email: byId('coachEmail').value.trim(),
      password: byId('coachPassword').value
    });
    if (error) { message('accessMessage', error.message); return; }
    let ready;
    try { ready = await activateSession(data.session); }
    catch (error) {
      status(`Помилка сесії: ${error.message}`);
      message('accessMessage', 'Не вдалося завершити вхід. Повторіть спробу.');
      return;
    }
    if (!ready) {
      message('accessMessage', 'Не вдалося відкрити кабінет тренера. Точний текст помилки показано у верхній частині сторінки.');
      return;
    }
    dialog('accessDialog', false);
  }

  async function playerLogin(event) {
    event.preventDefault();
    message('accessMessage', 'Вхід…');
    const { data, error } = await authDb.auth.signInWithPassword({
      email: playerEmail(byId('playerLogin').value),
      password: byId('playerPassword').value
    });
    if (error) { message('accessMessage', 'Неправильний логін або пароль.'); return; }
    let ready;
    try { ready = await activateSession(data.session); }
    catch (error) {
      status(`Помилка сесії: ${error.message}`);
      message('accessMessage', 'Не вдалося завершити вхід. Повторіть спробу.');
      return;
    }
    if (!ready) {
      await authDb.auth.signOut();
      message('accessMessage', 'Цей логін існує, але ще не прив’язаний до профілю. Тренер має створити доступ повторно.');
      return;
    }
    dialog('accessDialog', false);
  }

  async function createPlayerLogin(event) {
    event.preventDefault();
    const player = window.SportKidsApp.getPlayers().find(item => item.id === window.SportKidsApp.getActiveId());
    if (!session || mode !== 'coach') { message('credentialsMessage', 'Увійдіть як тренер, щоб створити доступ.'); return; }
    if (!player) { message('credentialsMessage', 'Оберіть профіль гравця.'); return; }
    const login = byId('newPlayerLogin').value.trim().toLowerCase();
    const password = byId('newPlayerPassword').value;
    if (!/^[a-z0-9._-]{3,30}$/.test(login)) {
      message('credentialsMessage', 'Логін: латинські літери, цифри, крапка, дефіс або _.');
      return;
    }

    message('credentialsMessage', 'Зберігаємо профіль…');
    const saved = await syncPlayers([player]);
    if (!saved || !player.cloudId) {
      message('credentialsMessage', 'Не вдалося зберегти профіль гравця у базі. Перевірте текст помилки у верхній частині сторінки.');
      return;
    }
    const coachId = session?.user?.id;
    const { data: existing, error: existingError } = await dataDb.from('player_accounts')
      .select('id, player_user_id, username')
      .eq('id', player.cloudId)
      .eq('coach_id', coachId)
      .maybeSingle();
    if (existingError || !existing) {
      message('credentialsMessage', existingError?.message || 'Профіль гравця не знайдено у вашому кабінеті.');
      return;
    }
    if (existing.player_user_id) {
      message('credentialsMessage', `Для цього профілю вже створено вхід${existing.username ? `: ${existing.username}` : ''}.`);
      return;
    }

    message('credentialsMessage', 'Створюємо доступ…');
    const isolated = window.supabase.createClient(config.url, config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const { data: signUp, error: signUpError } = await isolated.auth.signUp({
      email: playerEmail(login),
      password,
      options: { data: { role: 'player' } }
    });
    if (signUpError || !signUp.user) {
      const text = signUpError?.message || 'Не вдалося створити логін.';
      message('credentialsMessage', /already registered/i.test(text)
        ? 'Такий логін уже існує. Оберіть інший або видаліть старий непідключений вхід у Supabase → Authentication → Users.'
        : text);
      return;
    }
    if (!signUp.session) {
      message('credentialsMessage', 'У Supabase увімкнене підтвердження email. Вимкніть Confirm email у Authentication → Providers → Email, видаліть щойно створений непідключений вхід і повторіть дію.');
      return;
    }
    const { data: linked, error } = await dataDb.from('player_accounts')
      .update({ player_user_id: signUp.user.id, username: login })
      .eq('id', player.cloudId)
      .eq('coach_id', coachId)
      .select('id, player_user_id, username')
      .maybeSingle();
    if (error || !linked || linked.player_user_id !== signUp.user.id) {
      message('credentialsMessage', error?.message || 'Вхід створено, але не прив’язано. Не передавайте цей пароль; повторіть створення з іншим логіном.');
      return;
    }
    player.login = login;
    cacheCoachPlayers(coachId);
    message('credentialsMessage', `Готово. Логін гравця: ${login}`);
  }

  function queueSync(players) {
    if (mode !== 'coach') return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncPlayers(players); }, 600);
  }

  function chooseAccess(next) {
    document.querySelectorAll('[data-access]').forEach(button => button.classList.toggle('active', button.dataset.access === next));
    byId('coachLoginForm').classList.toggle('hidden', next !== 'coach');
    byId('playerLoginForm').classList.toggle('hidden', next !== 'player');
    message('accessMessage', '');
  }

  window.SportKidsSecure = {
    start: async () => {
      const openAccess = next => { chooseAccess(next); dialog('accessDialog', true); };
      byId('loginButton')?.addEventListener('click', () => openAccess('player'));
      byId('playerPortalButton')?.addEventListener('click', () => openAccess('player'));
      byId('welcomePlayerLogin')?.addEventListener('click', () => openAccess('player'));
      byId('coachPortalButton')?.addEventListener('click', () => openAccess('coach'));
      byId('logoutButton')?.addEventListener('click', () => authDb.auth.signOut());
      byId('accessClose')?.addEventListener('click', () => dialog('accessDialog', false));
      byId('credentialsClose')?.addEventListener('click', () => dialog('playerCredentialsDialog', false));
      byId('coachLoginForm')?.addEventListener('submit', coachLogin);
      byId('playerLoginForm')?.addEventListener('submit', playerLogin);
      byId('playerCredentialsForm')?.addEventListener('submit', createPlayerLogin);
      byId('createPlayerLogin')?.addEventListener('click', () => {
        if (mode !== 'coach') {
          chooseAccess('coach');
          message('accessMessage', 'Спочатку увійдіть у кабінет тренера. Після цього профіль і вхід гравця збережуться у базі.');
          dialog('accessDialog', true);
          return;
        }
        message('credentialsMessage', '');
        dialog('playerCredentialsDialog', true);
      });
      document.querySelectorAll('[data-access]').forEach(button => button.addEventListener('click', () => chooseAccess(button.dataset.access)));
      await refreshSession();
      authDb.auth.onAuthStateChange((event, nextSession) => {
        if (event === 'INITIAL_SESSION') return;
        // A token refresh only renews database access. It must never navigate a
        // coach away from the player profile they are reading or editing.
        setSession(nextSession);
        if (event === 'TOKEN_REFRESHED') return;
        const eventEpoch = sessionEpoch;
        setTimeout(() => {
          if (eventEpoch !== sessionEpoch) return;
          activateSession(nextSession).catch(error => status(`Помилка сесії: ${error.message}`));
        }, 0);
      });
    },
    queueSync,
    isCoach: () => Boolean(session) && mode === 'coach',
    requestCoachView: () => {
      if (session && mode === 'coach') {
        window.SportKidsApp?.setCoachView();
        return true;
      }
      chooseAccess('coach');
      message('accessMessage', 'Увійдіть як тренер, щоб відкрити кабінет команди.');
      dialog('accessDialog', true);
      return false;
    }
  };
})();
