const state = {
  userId: null,
  username: null,
  sessionToken: null,
  stocks: [],
  selectedSymbol: null,
  searchTerm: '',
  chart: null,
  ws: null,
  reconnectTimer: null,
  portfolioTimer: null,
  shouldReconnect: true,
};

const STORAGE = window.sessionStorage;
const STORAGE_KEYS = {
  userId: 'sim-trader-id',
  username: 'sim-trader-name',
  token: 'sim-trader-token',
};

window.addEventListener('DOMContentLoaded', init);

async function init() {
  setupTradeForm();
  setupAuth();
  setupSearch();
  connectWebSocket();
  await attemptRestoreSession();
}

function setupAuth() {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const switchToRegister = document.getElementById('switch-to-register');
  const switchToLogin = document.getElementById('switch-to-login');
  const logoutBtn = document.getElementById('logout-btn');

  if (switchToRegister) {
    switchToRegister.addEventListener('click', () => toggleAuthForm('register'));
  }
  if (switchToLogin) {
    switchToLogin.addEventListener('click', () => toggleAuthForm('login'));
  }
  if (logoutBtn) {
    logoutBtn.addEventListener('click', (event) => {
      event.preventDefault();
      performLogout();
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const username = document.getElementById('login-username').value.trim();
      const password = document.getElementById('login-password').value;
      const feedback = document.getElementById('login-feedback');
      setFeedback(feedback, '');
      if (!username || !password) {
        setFeedback(feedback, '请输入用户名和密码', true);
        return;
      }
      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await response.json();
        if (!response.ok) {
          setFeedback(feedback, data.detail || '登录失败', true);
          return;
        }
        handleAuthSuccess(data);
      } catch (error) {
        setFeedback(feedback, '网络异常，请稍后再试', true);
      }
    });
  }

  if (registerForm) {
    registerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const username = document.getElementById('register-username').value.trim();
      const password = document.getElementById('register-password').value;
      const feedback = document.getElementById('register-feedback');
      setFeedback(feedback, '');
      if (!username || !password) {
        setFeedback(feedback, '请输入用户名和密码', true);
        return;
      }
      try {
        const response = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await response.json();
        if (!response.ok) {
          setFeedback(feedback, data.detail || '注册失败', true);
          return;
        }
        handleAuthSuccess(data);
        setFeedback(feedback, '注册成功，已自动登录', false);
      } catch (error) {
        setFeedback(feedback, '网络异常，请稍后再试', true);
      }
    });
  }

  toggleAuthForm('login');
  updateAuthUI(false);
}

function toggleAuthForm(mode) {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  if (!loginForm || !registerForm) return;
  if (mode === 'register') {
    loginForm.classList.add('hidden');
    registerForm.classList.remove('hidden');
  } else {
    registerForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
  }
}

function setupSearch() {
  const input = document.getElementById('stock-search');
  if (!input) return;
  input.addEventListener('input', (event) => {
    state.searchTerm = event.target.value.trim();
    updateStockTable();
    const filtered = getFilteredStocks();
    if (
      state.selectedSymbol &&
      !filtered.some((stock) => stock.symbol === state.selectedSymbol)
    ) {
      if (filtered.length > 0) {
        selectStock(filtered[0].symbol);
        return;
      }
      state.selectedSymbol = null;
    }
    highlightSelection();
    if (state.selectedSymbol) {
      updateChart(state.selectedSymbol);
    }
  });
}

function getFilteredStocks() {
  if (!state.searchTerm) {
    return state.stocks;
  }
  const term = state.searchTerm.toLowerCase();
  return state.stocks.filter((stock) => {
    const symbol = stock.symbol.toLowerCase();
    const nameLower = (stock.name || '').toLowerCase();
    return (
      symbol.includes(term) ||
      nameLower.includes(term) ||
      (stock.name && stock.name.includes(state.searchTerm))
    );
  });
}

async function attemptRestoreSession() {
  const storedId = STORAGE.getItem(STORAGE_KEYS.userId);
  const storedName = STORAGE.getItem(STORAGE_KEYS.username);
  const storedToken = STORAGE.getItem(STORAGE_KEYS.token);
  if (!storedId || !storedName || !storedToken) {
    updateAuthUI(false);
    return;
  }
  try {
    const response = await fetch('/api/profile', {
      headers: { 'X-Session-Token': storedToken },
    });
    if (!response.ok) {
      throw new Error('profile');
    }
    const data = await response.json();
    if (!data.token) {
      data.token = storedToken;
    }
    handleAuthSuccess(data, false);
  } catch (err) {
    clearStoredSession();
    updateAuthUI(false);
  }
}

function handleAuthSuccess(authData, notify = true) {
  state.userId = authData.user_id;
  state.username = authData.username;
  state.sessionToken = authData.token;
  storeSession(authData.user_id, authData.username, authData.token);
  updateAuthUI(true);
  if (notify) {
    const loginFeedback = document.getElementById('login-feedback');
    if (loginFeedback) {
      setFeedback(loginFeedback, '登录成功', false);
    }
  }
  startPortfolioRefresh();
}

function storeSession(userId, username, token) {
  STORAGE.setItem(STORAGE_KEYS.userId, userId);
  STORAGE.setItem(STORAGE_KEYS.username, username);
  STORAGE.setItem(STORAGE_KEYS.token, token);
}

function clearStoredSession() {
  STORAGE.removeItem(STORAGE_KEYS.userId);
  STORAGE.removeItem(STORAGE_KEYS.username);
  STORAGE.removeItem(STORAGE_KEYS.token);
}

async function performLogout(options = {}) {
  const { skipRequest = false, expired = false } = options;
  if (!skipRequest && state.sessionToken) {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'X-Session-Token': state.sessionToken },
      });
    } catch (err) {
      // ignore network issues on logout
    }
  }
  stopPortfolioRefresh();
  state.userId = null;
  state.username = null;
  state.sessionToken = null;
  state.selectedSymbol = null;
  state.searchTerm = '';
  clearStoredSession();
  resetPortfolio();
  updateAuthUI(false);
  toggleAuthForm('login');
  const searchInput = document.getElementById('stock-search');
  if (searchInput) {
    searchInput.value = '';
  }
  updateStockTable();
  highlightSelection();
  if (expired) {
    const feedback = document.getElementById('login-feedback');
    if (feedback) {
      setFeedback(feedback, '当前账号已在其他页面登录，本次会话已退出', true);
    }
  }
}

function updateAuthUI(isAuthenticated) {
  const formsContainer = document.getElementById('auth-forms');
  const userInfo = document.getElementById('user-info');
  const userNameEl = document.getElementById('user-name');
  if (isAuthenticated) {
    if (formsContainer) formsContainer.classList.add('hidden');
    if (userInfo) userInfo.classList.remove('hidden');
    if (userNameEl) userNameEl.textContent = state.username || '';
    setTradeFormDisabled(false);
  } else {
    if (formsContainer) formsContainer.classList.remove('hidden');
    if (userInfo) userInfo.classList.add('hidden');
    if (userNameEl) userNameEl.textContent = '';
    setTradeFormDisabled(true);
  }
}

function setFeedback(element, message, isError = false) {
  if (!element) return;
  element.textContent = message;
  element.classList.remove('error', 'success');
  if (!message) return;
  element.classList.add(isError ? 'error' : 'success');
}

function storePortfolioTimer(timer) {
  if (state.portfolioTimer) {
    clearInterval(state.portfolioTimer);
  }
  state.portfolioTimer = timer;
}

function startPortfolioRefresh() {
  refreshPortfolio();
  storePortfolioTimer(setInterval(refreshPortfolio, 10_000));
  const notice = document.getElementById('trade-auth-notice');
  if (notice) notice.classList.add('hidden');
}

function stopPortfolioRefresh() {
  if (state.portfolioTimer) {
    clearInterval(state.portfolioTimer);
    state.portfolioTimer = null;
  }
  const notice = document.getElementById('trade-auth-notice');
  if (notice) notice.classList.remove('hidden');
}

function connectWebSocket() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws/quotes`);
  state.ws = ws;
  ws.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    handleMarketUpdate(payload);
  });
  ws.addEventListener('close', () => {
    state.ws = null;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
    }
    if (state.shouldReconnect) {
      state.reconnectTimer = setTimeout(connectWebSocket, 3000);
    }
  });
}

async function refreshPortfolio() {
  if (!state.userId || !state.sessionToken) return;
  try {
    const response = await fetch('/api/portfolio', {
      headers: { 'X-Session-Token': state.sessionToken },
    });
    if (response.status === 401) {
      await performLogout({ skipRequest: true, expired: true });
      return;
    }
    if (!response.ok) return;
    const portfolio = await response.json();
    renderPortfolio(portfolio);
  } catch (error) {
    // ignore network errors for periodic refresh
  }
}

function renderPortfolio(portfolio) {
  document.getElementById('cash-balance').textContent = portfolio.cash.toFixed(2);
  document.getElementById('total-value').textContent = portfolio.total_value.toFixed(2);

  const tbody = document.getElementById('portfolio-table');
  tbody.innerHTML = '';
  portfolio.holdings.forEach((holding) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${holding.symbol}</td>
      <td>${holding.name}</td>
      <td class="numeric">${holding.quantity}</td>
      <td class="numeric">${holding.market_value.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  });

  const historyList = document.getElementById('trade-history');
  historyList.innerHTML = '';
  portfolio.history
    .slice()
    .reverse()
    .forEach((record) => {
      const li = document.createElement('li');
      li.textContent = `${formatTimestamp(record.timestamp)} ${record.side === 'buy' ? '买入' : '卖出'} ${record.symbol} ${record.quantity} 股 @ ${record.price.toFixed(2)} 元`;
      historyList.appendChild(li);
    });
}

function resetPortfolio() {
  document.getElementById('cash-balance').textContent = '--';
  document.getElementById('total-value').textContent = '--';
  document.getElementById('portfolio-table').innerHTML = '';
  document.getElementById('trade-history').innerHTML = '';
  const feedback = document.getElementById('trade-feedback');
  if (feedback) {
    feedback.textContent = '';
    feedback.classList.remove('error', 'success');
  }
}

function handleMarketUpdate(snapshot) {
  if (!snapshot || !snapshot.stocks) return;
  state.stocks = snapshot.stocks;
  updateMarketStatus(snapshot.market_status);
  const filtered = getFilteredStocks();
  if (
    !state.selectedSymbol ||
    !state.stocks.some((stock) => stock.symbol === state.selectedSymbol)
  ) {
    if (filtered.length > 0) {
      state.selectedSymbol = filtered[0].symbol;
    } else if (state.stocks.length > 0) {
      state.selectedSymbol = state.stocks[0].symbol;
    } else {
      state.selectedSymbol = null;
    }
  }
  updateStockTable();
  updateSymbolOptions();
  highlightSelection();
  if (state.selectedSymbol) {
    updateChart(state.selectedSymbol);
  } else if (state.chart) {
    state.chart.data.labels = [];
    state.chart.data.datasets[0].data = [];
    state.chart.update('none');
    document.getElementById('chart-title').textContent = '走势';
  }
}

function updateMarketStatus(status) {
  const container = document.getElementById('market-status');
  if (!container) return;
  container.querySelector('.label').textContent = status.label;
  const countdownEl = container.querySelector('.countdown');
  if (status.countdown != null) {
    countdownEl.textContent = formatCountdown(status.countdown);
  } else {
    countdownEl.textContent = '';
  }
}

function formatCountdown(seconds) {
  const hrs = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const secs = String(seconds % 60).padStart(2, '0');
  return `距离下个阶段 ${hrs}:${mins}:${secs}`;
}

function updateStockTable() {
  const tbody = document.getElementById('stock-table');
  tbody.innerHTML = '';
  const stocks = getFilteredStocks();
  if (stocks.length === 0) {
    if (state.stocks.length === 0) {
      return;
    }
    const tr = document.createElement('tr');
    tr.classList.add('empty');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.textContent = '未找到匹配的股票';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  stocks.forEach((stock) => {
    const tr = document.createElement('tr');
    tr.dataset.symbol = stock.symbol;
    tr.addEventListener('click', () => selectStock(stock.symbol));

    const changeClass = stock.change >= 0 ? 'price-up' : 'price-down';
    const changeSign = stock.change >= 0 ? '+' : '';

    tr.innerHTML = `
      <td>${stock.symbol}</td>
      <td>${stock.name}</td>
      <td class="numeric ${changeClass}">${stock.price.toFixed(2)}</td>
      <td class="numeric ${changeClass}">${changeSign}${stock.change_percent.toFixed(2)}%</td>
      <td class="numeric">${stock.high.toFixed(2)}</td>
      <td class="numeric">${stock.low.toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function updateSymbolOptions() {
  const select = document.getElementById('trade-symbol');
  const prevValue = state.selectedSymbol || select.value;
  select.innerHTML = '';
  state.stocks.forEach((stock) => {
    const option = document.createElement('option');
    option.value = stock.symbol;
    option.textContent = `${stock.symbol} - ${stock.name}`;
    select.appendChild(option);
  });

  if (prevValue && state.stocks.some((stock) => stock.symbol === prevValue)) {
    select.value = prevValue;
  } else if (state.stocks.length > 0) {
    const fallback = state.stocks[0].symbol;
    select.value = fallback;
    state.selectedSymbol = fallback;
  }
}

function selectStock(symbol) {
  state.selectedSymbol = symbol;
  updateChart(symbol);
  updateSymbolOptions();
  highlightSelection();
}

function highlightSelection() {
  const rows = document.querySelectorAll('#stock-table tr');
  rows.forEach((row) => {
    if (row.dataset.symbol === state.selectedSymbol) {
      row.classList.add('selected');
    } else {
      row.classList.remove('selected');
    }
  });
}

function updateChart(symbol) {
  const stock = state.stocks.find((s) => s.symbol === symbol);
  if (!stock) return;
  document.getElementById('chart-title').textContent = `${stock.symbol} ${stock.name} 走势`;
  const ctx = document.getElementById('price-chart');
  const labels = stock.history.map((point) => new Date(point.timestamp));
  const data = stock.history.map((point) => point.price);

  if (!state.chart) {
    state.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '价格 (元)',
            data,
            tension: 0.3,
            borderColor: '#ff4d4f',
            backgroundColor: 'rgba(255, 77, 79, 0.15)',
            fill: true,
            pointRadius: 0,
          },
        ],
      },
      options: {
        scales: {
          x: {
            type: 'time',
            time: {
              unit: 'minute',
            },
            ticks: {
              color: '#9aa5b1',
            },
          },
          y: {
            ticks: {
              color: '#9aa5b1',
              callback: (value) => value.toFixed(2),
            },
            grid: {
              color: 'rgba(255, 255, 255, 0.05)',
            },
          },
        },
        plugins: {
          legend: {
            labels: {
              color: '#f3f4f6',
            },
          },
        },
      },
    });
  } else {
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = data;
    state.chart.update('none');
  }
}

function setupTradeForm() {
  const form = document.getElementById('trade-form');
  const sideSelect = document.getElementById('trade-side');
  const quantityInput = document.getElementById('trade-quantity');

  const applyQuantityConstraints = () => {
    if (!quantityInput || !sideSelect) return;
    const currentValue = parseInt(quantityInput.value, 10);
    if (sideSelect.value === 'buy') {
      quantityInput.min = '100';
      quantityInput.step = '100';
      if (!Number.isInteger(currentValue) || currentValue < 100) {
        quantityInput.value = '100';
      } else if (currentValue % 100 !== 0) {
        quantityInput.value = String(Math.ceil(currentValue / 100) * 100);
      }
    } else {
      quantityInput.min = '1';
      quantityInput.step = '1';
      if (!Number.isInteger(currentValue) || currentValue < 1) {
        quantityInput.value = '1';
      }
    }
  };

  if (sideSelect) {
    sideSelect.addEventListener('change', applyQuantityConstraints);
  }
  if (quantityInput) {
    quantityInput.addEventListener('change', applyQuantityConstraints);
  }
  applyQuantityConstraints();

  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!state.userId || !state.sessionToken) {
        const feedback = document.getElementById('trade-feedback');
        setFeedback(feedback, '请先登录后再提交交易', true);
        return;
      }
      const symbol = document.getElementById('trade-symbol').value;
      const side = document.getElementById('trade-side').value;
      const quantity = parseInt(document.getElementById('trade-quantity').value, 10);
      const feedback = document.getElementById('trade-feedback');
      setFeedback(feedback, '');

      if (!Number.isInteger(quantity) || quantity <= 0) {
        setFeedback(feedback, '请输入正确的交易数量', true);
        return;
      }

      if (side === 'buy' && quantity % 100 !== 0) {
        setFeedback(feedback, '买入数量必须为100股的整数倍', true);
        return;
      }

      try {
        const response = await fetch('/api/trade', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Session-Token': state.sessionToken,
          },
          body: JSON.stringify({ symbol, side, quantity }),
        });
        const data = await response.json();
        if (response.status === 401) {
          await performLogout({ skipRequest: true, expired: true });
          return;
        }
        if (!response.ok) {
          setFeedback(feedback, data.detail || '交易失败', true);
          return;
        }
        setFeedback(feedback, `${side === 'buy' ? '买入' : '卖出'}成功！`, false);
        renderPortfolio(data.portfolio);
        refreshPortfolio();
      } catch (err) {
        setFeedback(feedback, '网络异常，请稍后再试', true);
      }
    });
  }

  setTradeFormDisabled(true);
}

function setTradeFormDisabled(disabled) {
  const fieldset = document.getElementById('trade-fieldset');
  if (fieldset) {
    fieldset.disabled = disabled;
  }
  const notice = document.getElementById('trade-auth-notice');
  if (notice) {
    notice.classList.toggle('hidden', !disabled);
  }
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}
