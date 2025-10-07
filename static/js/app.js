const STORAGE = window.sessionStorage;
const STORAGE_KEYS = {
  userId: 'sim-trader-id',
  username: 'sim-trader-name',
  token: 'sim-trader-token',
  flash: 'sim-trader-flash',
};

const appState = {
  page: null,
  session: null,
  stocks: [],
  searchTerm: '',
  ws: null,
  reconnectTimer: null,
  shouldReconnect: true,
  portfolioTimer: null,
  chart: null,
  detailSymbol: null,
};

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body?.dataset?.page || '';
  appState.page = page;
  switch (page) {
    case 'login':
      initLoginPage();
      break;
    case 'register':
      initRegisterPage();
      break;
    case 'dashboard':
      initDashboardPage();
      break;
    case 'stock-detail':
      initStockDetailPage();
      break;
    default:
      break;
  }
});

async function initLoginPage() {
  displayFlashMessage();
  const session = await tryRestoreSession();
  if (session) {
    redirectToApp();
    return;
  }
  const form = document.getElementById('login-form');
  const feedback = document.getElementById('login-feedback');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFeedback(feedback);
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
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
      persistSession(data);
      redirectToApp();
    } catch (error) {
      setFeedback(feedback, '网络异常，请稍后再试', true);
    }
  });
}

async function initRegisterPage() {
  displayFlashMessage();
  const session = await tryRestoreSession();
  if (session) {
    redirectToApp();
    return;
  }
  const form = document.getElementById('register-form');
  const feedback = document.getElementById('register-feedback');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFeedback(feedback);
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;
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
      setFeedback(feedback, '注册成功，正在跳转...', false);
      persistSession(data);
      redirectToApp();
    } catch (error) {
      setFeedback(feedback, '网络异常，请稍后再试', true);
    }
  });
}

async function initDashboardPage() {
  displayFlashMessage();
  const session = await ensureSession();
  if (!session) return;
  appState.session = session;
  appState.shouldReconnect = true;
  updateUserName(session.username);
  setupLogout();
  setupSearch();
  setupTradeForm();
  connectQuotes(handleDashboardSnapshot);
  startPortfolioRefresh();
  window.addEventListener('beforeunload', cleanupResources);
}

async function initStockDetailPage() {
  displayFlashMessage();
  appState.detailSymbol = document.body?.dataset?.symbol || '';
  const session = await ensureSession();
  if (!session) return;
  appState.session = session;
  appState.shouldReconnect = true;
  updateUserName(session.username);
  setupLogout();
  const loaded = await loadInitialStockDetail();
  if (!loaded) return;
  setupDetailTradeForm();
  connectQuotes(handleDetailSnapshot);
  startPortfolioRefresh();
  window.addEventListener('beforeunload', cleanupResources);
}

function setupLogout() {
  const button = document.getElementById('logout-btn');
  button?.addEventListener('click', async () => {
    await performLogout();
    redirectToLogin();
  });
}

function updateUserName(name) {
  const el = document.getElementById('user-name');
  if (el) {
    el.textContent = name || '';
  }
}

async function ensureSession() {
  const stored = getStoredSession();
  if (!stored) {
    redirectToLogin();
    return null;
  }
  try {
    const profile = await fetchProfile(stored.token);
    persistSession(profile);
    return profile;
  } catch (error) {
    clearStoredSession();
    redirectToLogin();
    return null;
  }
}

async function tryRestoreSession() {
  const stored = getStoredSession();
  if (!stored) return null;
  try {
    const profile = await fetchProfile(stored.token);
    persistSession(profile);
    return profile;
  } catch (error) {
    clearStoredSession();
    return null;
  }
}

function getStoredSession() {
  const userId = STORAGE.getItem(STORAGE_KEYS.userId);
  const username = STORAGE.getItem(STORAGE_KEYS.username);
  const token = STORAGE.getItem(STORAGE_KEYS.token);
  if (!userId || !username || !token) return null;
  return { user_id: userId, username, token };
}

function persistSession(data) {
  STORAGE.setItem(STORAGE_KEYS.userId, data.user_id);
  STORAGE.setItem(STORAGE_KEYS.username, data.username);
  STORAGE.setItem(STORAGE_KEYS.token, data.token);
}

function clearStoredSession() {
  STORAGE.removeItem(STORAGE_KEYS.userId);
  STORAGE.removeItem(STORAGE_KEYS.username);
  STORAGE.removeItem(STORAGE_KEYS.token);
}

async function fetchProfile(token) {
  const response = await fetch('/api/profile', {
    headers: { 'X-Session-Token': token },
  });
  if (!response.ok) {
    throw new Error('profile');
  }
  return response.json();
}

function redirectToApp() {
  window.location.href = '/app';
}

function redirectToLogin() {
  window.location.href = '/';
}

function setupSearch() {
  const input = document.getElementById('stock-search');
  if (!input) return;
  input.addEventListener('input', (event) => {
    appState.searchTerm = event.target.value.trim();
    renderStockList();
  });
}

function setupTradeForm() {
  const form = document.getElementById('trade-form');
  const sideSelect = document.getElementById('trade-side');
  const quantityInput = document.getElementById('trade-quantity');
  const applyConstraints = () => {
    if (!quantityInput || !sideSelect) return;
    const value = parseInt(quantityInput.value, 10);
    if (sideSelect.value === 'buy') {
      quantityInput.min = '100';
      quantityInput.step = '100';
      if (!Number.isInteger(value) || value < 100) {
        quantityInput.value = '100';
      } else if (value % 100 !== 0) {
        quantityInput.value = String(Math.ceil(value / 100) * 100);
      }
    } else {
      quantityInput.min = '1';
      quantityInput.step = '1';
      if (!Number.isInteger(value) || value < 1) {
        quantityInput.value = '1';
      }
    }
  };
  sideSelect?.addEventListener('change', applyConstraints);
  quantityInput?.addEventListener('change', applyConstraints);
  applyConstraints();
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitTrade({
      symbol: document.getElementById('trade-symbol').value,
      side: document.getElementById('trade-side').value,
      quantity: parseInt(document.getElementById('trade-quantity').value, 10),
      feedback: document.getElementById('trade-feedback'),
    });
  });
}

function setupDetailTradeForm() {
  const form = document.getElementById('detail-trade-form');
  const sideSelect = document.getElementById('detail-trade-side');
  const quantityInput = document.getElementById('detail-trade-quantity');
  const applyConstraints = () => {
    if (!quantityInput || !sideSelect) return;
    const value = parseInt(quantityInput.value, 10);
    if (sideSelect.value === 'buy') {
      quantityInput.min = '100';
      quantityInput.step = '100';
      if (!Number.isInteger(value) || value < 100) {
        quantityInput.value = '100';
      } else if (value % 100 !== 0) {
        quantityInput.value = String(Math.ceil(value / 100) * 100);
      }
    } else {
      quantityInput.min = '1';
      quantityInput.step = '1';
      if (!Number.isInteger(value) || value < 1) {
        quantityInput.value = '1';
      }
    }
  };
  sideSelect?.addEventListener('change', applyConstraints);
  quantityInput?.addEventListener('change', applyConstraints);
  applyConstraints();
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitTrade({
      symbol: appState.detailSymbol,
      side: document.getElementById('detail-trade-side').value,
      quantity: parseInt(document.getElementById('detail-trade-quantity').value, 10),
      feedback: document.getElementById('detail-trade-feedback'),
    });
  });
}

async function submitTrade({ symbol, side, quantity, feedback }) {
  if (!appState.session) {
    setFeedback(feedback, '登录状态已失效，请重新登录', true);
    redirectToLogin();
    return;
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    setFeedback(feedback, '请输入正确的交易数量', true);
    return;
  }
  if (side === 'buy' && quantity % 100 !== 0) {
    setFeedback(feedback, '买入数量必须为100股的整数倍', true);
    return;
  }
  clearFeedback(feedback);
  try {
    const response = await fetch('/api/trade', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': appState.session.token,
      },
      body: JSON.stringify({ symbol, side, quantity }),
    });
    const data = await response.json();
    if (response.status === 401) {
      await handleSessionExpired();
      return;
    }
    if (!response.ok) {
      setFeedback(feedback, data.detail || '交易失败', true);
      return;
    }
    setFeedback(feedback, `${side === 'buy' ? '买入' : '卖出'}成功！`, false);
    renderPortfolio(data.portfolio);
  } catch (error) {
    setFeedback(feedback, '网络异常，请稍后再试', true);
  }
}

async function loadInitialStockDetail() {
  try {
    const response = await fetch(`/api/stocks/${encodeURIComponent(appState.detailSymbol)}`);
    if (!response.ok) {
      setFlashMessage('未找到该股票，返回行情列表');
      redirectToApp();
      return false;
    }
    const stock = await response.json();
    applyDetailStock(stock);
    return true;
  } catch (error) {
    setFlashMessage('加载个股信息失败，请稍后再试');
    redirectToApp();
    return false;
  }
}

function connectQuotes(handler) {
  if (appState.ws && (appState.ws.readyState === WebSocket.OPEN || appState.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws/quotes`);
  appState.ws = ws;
  ws.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    updateMarketStatus(payload.market_status);
    handler(payload);
  });
  ws.addEventListener('close', () => {
    appState.ws = null;
    if (appState.reconnectTimer) {
      clearTimeout(appState.reconnectTimer);
    }
    if (appState.shouldReconnect) {
      appState.reconnectTimer = setTimeout(() => connectQuotes(handler), 3000);
    }
  });
}

function handleDashboardSnapshot(snapshot) {
  if (!snapshot?.stocks) return;
  appState.stocks = snapshot.stocks;
  renderStockList();
  updateSymbolOptions();
}

function handleDetailSnapshot(snapshot) {
  if (!snapshot?.stocks) return;
  const stock = snapshot.stocks.find((item) => item.symbol === appState.detailSymbol);
  if (stock) {
    applyDetailStock(stock);
  }
}

function renderStockList() {
  const container = document.getElementById('stock-list');
  const emptyHint = document.getElementById('stock-empty');
  if (!container) return;
  container.innerHTML = '';
  const term = appState.searchTerm.toLowerCase();
  const filtered = appState.stocks.filter((stock) => {
    if (!term) return true;
    const symbol = stock.symbol.toLowerCase();
    const name = (stock.name || '').toLowerCase();
    return symbol.includes(term) || name.includes(term);
  });
  if (filtered.length === 0) {
    emptyHint?.classList.remove('hidden');
    return;
  }
  emptyHint?.classList.add('hidden');
  filtered.forEach((stock) => {
    const changeClass = stock.change > 0 ? 'up' : stock.change < 0 ? 'down' : 'flat';
    const priceClass = stock.change >= 0 ? 'price-up' : 'price-down';
    const changeSign = stock.change >= 0 ? '+' : '';
    const row = document.createElement('div');
    row.className = `stock-row ${changeClass}`;
    row.innerHTML = `
      <div class="stock-topline">
        <div>
          <span class="symbol">${stock.symbol}</span>
          <span class="name">${stock.name}</span>
        </div>
        <div>
          <span class="stock-price ${priceClass}">${stock.price.toFixed(2)}</span>
          <span class="stock-change ${priceClass}">${changeSign}${stock.change.toFixed(2)} (${changeSign}${stock.change_percent.toFixed(2)}%)</span>
        </div>
      </div>
      <div class="stock-bottomline">
        <span>今开<strong>${stock.open.toFixed(2)}</strong></span>
        <span>昨收<strong>${stock.prev_close.toFixed(2)}</strong></span>
        <span>最高<strong>${stock.high.toFixed(2)}</strong></span>
        <span>最低<strong>${stock.low.toFixed(2)}</strong></span>
        <span>涨停<strong>${stock.limit_up.toFixed(2)}</strong></span>
        <span>跌停<strong>${stock.limit_down.toFixed(2)}</strong></span>
      </div>
    `;
    row.addEventListener('click', () => {
      window.location.href = `/stocks/${stock.symbol}`;
    });
    container.appendChild(row);
  });
}

function updateSymbolOptions() {
  const select = document.getElementById('trade-symbol');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '';
  appState.stocks.forEach((stock) => {
    const option = document.createElement('option');
    option.value = stock.symbol;
    option.textContent = `${stock.symbol} - ${stock.name}`;
    select.appendChild(option);
  });
  if (current && appState.stocks.some((stock) => stock.symbol === current)) {
    select.value = current;
  }
}

function applyDetailStock(stock) {
  const priceEl = document.getElementById('detail-price');
  const changeEl = document.getElementById('detail-change');
  const changeSign = stock.change >= 0 ? '+' : '';
  const priceClass = stock.change >= 0 ? 'price-up' : 'price-down';
  if (priceEl) {
    priceEl.textContent = stock.price.toFixed(2);
    priceEl.classList.remove('price-up', 'price-down');
    priceEl.classList.add(priceClass);
  }
  if (changeEl) {
    changeEl.textContent = `${changeSign}${stock.change.toFixed(2)} (${changeSign}${stock.change_percent.toFixed(2)}%)`;
    changeEl.classList.remove('price-up', 'price-down');
    changeEl.classList.add(priceClass);
  }
  assignText('detail-open', stock.open.toFixed(2));
  assignText('detail-prev-close', stock.prev_close.toFixed(2));
  assignText('detail-high', stock.high.toFixed(2));
  assignText('detail-low', stock.low.toFixed(2));
  assignText('detail-limit-up', stock.limit_up.toFixed(2));
  assignText('detail-limit-down', stock.limit_down.toFixed(2));
  updateDetailChart(stock);
}

function assignText(id, text) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
  }
}

function updateDetailChart(stock) {
  if (!stock?.history) return;
  const ctx = document.getElementById('stock-chart');
  if (!ctx) return;
  const labels = stock.history.map((point) => new Date(point.timestamp));
  const data = stock.history.map((point) => point.price);
  const minPrice = Math.min(...data);
  const maxPrice = Math.max(...data);
  const rawRange = maxPrice - minPrice;
  const baseRange = Math.max(rawRange, maxPrice * 0.002, 0.05);
  const padding = baseRange * 0.12;
  const suggestedMin = Math.max(0, minPrice - padding);
  const suggestedMax = maxPrice + padding;
  if (!appState.chart) {
    if (typeof Chart === 'undefined') return;
    appState.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: `${stock.symbol} 价格`,
            data,
            borderColor: '#f39c12',
            backgroundColor: 'rgba(243, 156, 18, 0.12)',
            borderWidth: 2,
            tension: 0.15,
            pointRadius: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            type: 'time',
            time: {
              tooltipFormat: 'yyyy-MM-dd HH:mm:ss',
            },
            ticks: {
              color: '#cbd5f5',
            },
            grid: {
              color: 'rgba(255, 255, 255, 0.08)',
            },
          },
          y: {
            beginAtZero: false,
            suggestedMin,
            suggestedMax,
            bounds: 'ticks',
            grace: '6%',
            ticks: {
              color: '#cbd5f5',
            },
            grid: {
              color: 'rgba(255, 255, 255, 0.08)',
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
    appState.chart.data.labels = labels;
    appState.chart.data.datasets[0].data = data;
    const yScale = appState.chart.options?.scales?.y;
    if (yScale) {
      yScale.beginAtZero = false;
      yScale.suggestedMin = suggestedMin;
      yScale.suggestedMax = suggestedMax;
    }
    appState.chart.update('resize');
  }
}

function updateMarketStatus(status) {
  const container = document.getElementById('market-status');
  if (!container || !status) return;
  const label = container.querySelector('.label');
  const countdown = container.querySelector('.countdown');
  if (label) label.textContent = status.label;
  if (countdown) {
    countdown.textContent = status.countdown != null ? formatCountdown(status.countdown) : '';
  }
}

function formatCountdown(seconds) {
  const hrs = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const mins = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const secs = String(seconds % 60).padStart(2, '0');
  return `距离下个阶段 ${hrs}:${mins}:${secs}`;
}

async function startPortfolioRefresh() {
  await refreshPortfolio();
  if (appState.portfolioTimer) {
    clearInterval(appState.portfolioTimer);
  }
  appState.portfolioTimer = setInterval(refreshPortfolio, 10_000);
}

async function refreshPortfolio() {
  if (!appState.session) return;
  try {
    const response = await fetch('/api/portfolio', {
      headers: { 'X-Session-Token': appState.session.token },
    });
    if (response.status === 401) {
      await handleSessionExpired();
      return;
    }
    if (!response.ok) return;
    const portfolio = await response.json();
    renderPortfolio(portfolio);
  } catch (error) {
    // ignore
  }
}

function renderPortfolio(portfolio) {
  assignText('cash-balance', portfolio?.cash?.toFixed ? portfolio.cash.toFixed(2) : '--');
  assignText('total-value', portfolio?.total_value?.toFixed ? portfolio.total_value.toFixed(2) : '--');
  const tbody = document.getElementById('portfolio-table');
  if (tbody) {
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
  }
  const historyList = document.getElementById('trade-history');
  if (historyList) {
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
  const detailCash = document.getElementById('detail-cash');
  if (detailCash) {
    detailCash.textContent = portfolio.cash.toFixed(2);
    const detailSymbol = appState.detailSymbol;
    const holding = portfolio.holdings.find((item) => item.symbol === detailSymbol);
    const qtyEl = document.getElementById('detail-holding-qty');
    const valueEl = document.getElementById('detail-holding-value');
    if (holding) {
      if (qtyEl) qtyEl.textContent = holding.quantity;
      if (valueEl) valueEl.textContent = holding.market_value.toFixed(2);
    } else {
      if (qtyEl) qtyEl.textContent = '0';
      if (valueEl) valueEl.textContent = '0.00';
    }
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

function setFeedback(element, message, isError = false) {
  if (!element) return;
  element.textContent = message;
  element.classList.remove('error', 'success');
  if (!message) return;
  element.classList.add(isError ? 'error' : 'success');
}

function clearFeedback(element) {
  if (!element) return;
  element.textContent = '';
  element.classList.remove('error', 'success');
}

async function performLogout() {
  if (appState.session?.token) {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'X-Session-Token': appState.session.token },
      });
    } catch (error) {
      // ignore
    }
  }
  cleanupResources();
  clearStoredSession();
}

async function handleSessionExpired() {
  cleanupResources();
  clearStoredSession();
  setFlashMessage('当前账号已在其他页面登录，本次会话已退出');
  redirectToLogin();
}

function cleanupResources() {
  appState.shouldReconnect = false;
  if (appState.ws) {
    try {
      appState.ws.close();
    } catch (error) {
      // ignore
    }
    appState.ws = null;
  }
  if (appState.reconnectTimer) {
    clearTimeout(appState.reconnectTimer);
    appState.reconnectTimer = null;
  }
  if (appState.portfolioTimer) {
    clearInterval(appState.portfolioTimer);
    appState.portfolioTimer = null;
  }
}

function setFlashMessage(message) {
  STORAGE.setItem(STORAGE_KEYS.flash, message);
}

function displayFlashMessage() {
  const message = STORAGE.getItem(STORAGE_KEYS.flash);
  if (!message) return;
  STORAGE.removeItem(STORAGE_KEYS.flash);
  const container = document.getElementById('flash-container');
  const content = document.getElementById('flash-message');
  if (!container || !content) return;
  content.textContent = message;
  container.classList.remove('hidden');
  setTimeout(() => {
    container.classList.add('hidden');
  }, 4000);
}
