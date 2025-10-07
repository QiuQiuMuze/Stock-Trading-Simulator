const state = {
  userId: null,
  stocks: [],
  selectedSymbol: null,
  chart: null,
  ws: null,
  reconnectTimer: null,
};

async function init() {
  await ensureSession();
  setupTradeForm();
  connectWebSocket();
  await refreshPortfolio();
  setInterval(refreshPortfolio, 10_000);
}

async function ensureSession() {
  let userId = localStorage.getItem('sim-trader-id');
  if (!userId) {
    const response = await fetch('/api/session', { method: 'POST' });
    const data = await response.json();
    userId = data.user_id;
    localStorage.setItem('sim-trader-id', userId);
  }
  state.userId = userId;
}

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws/quotes`);
  state.ws = ws;

  ws.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    handleMarketUpdate(payload);
  });

  ws.addEventListener('close', () => {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
    }
    state.reconnectTimer = setTimeout(connectWebSocket, 3000);
  });
}

function handleMarketUpdate(snapshot) {
  if (!snapshot || !snapshot.stocks) return;
  state.stocks = snapshot.stocks;
  updateMarketStatus(snapshot.market_status);
  updateStockTable();
  updateSymbolOptions();
  highlightSelection();
  if (!state.selectedSymbol && state.stocks.length > 0) {
    selectStock(state.stocks[0].symbol);
  } else if (state.selectedSymbol) {
    updateChart(state.selectedSymbol);
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
  state.stocks.forEach((stock) => {
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
    select.value = state.stocks[0].symbol;
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

async function refreshPortfolio() {
  if (!state.userId) return;
  const response = await fetch('/api/portfolio', {
    headers: { 'X-User-Id': state.userId },
  });
  if (!response.ok) return;
  const portfolio = await response.json();
  renderPortfolio(portfolio);
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

function setupTradeForm() {
  const form = document.getElementById('trade-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.userId) return;
    const symbol = document.getElementById('trade-symbol').value;
    const side = document.getElementById('trade-side').value;
    const quantity = parseInt(document.getElementById('trade-quantity').value, 10);
    const feedback = document.getElementById('trade-feedback');
    feedback.textContent = '';
    feedback.classList.remove('error', 'success');

    if (!quantity || quantity <= 0) {
      feedback.textContent = '请输入正确的交易数量';
      feedback.classList.add('error');
      return;
    }

    try {
      const response = await fetch('/api/trade', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': state.userId,
        },
        body: JSON.stringify({ symbol, side, quantity }),
      });
      const data = await response.json();
      if (!response.ok) {
        feedback.textContent = data.detail || '交易失败';
        feedback.classList.add('error');
        return;
      }
      feedback.textContent = `${side === 'buy' ? '买入' : '卖出'}成功！`;
      feedback.classList.add('success');
      renderPortfolio(data.portfolio);
      refreshPortfolio();
    } catch (err) {
      feedback.textContent = '网络异常，请稍后再试';
      feedback.classList.add('error');
    }
  });
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

window.addEventListener('DOMContentLoaded', init);
