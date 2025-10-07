import asyncio
import contextlib
import os
import random
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from enum import Enum
from typing import Deque, Dict, List, Optional

import pytz


class MarketPhase(Enum):
    PREOPEN = "preopen"
    MORNING = "morning_session"
    MIDDAY_BREAK = "midday_break"
    AFTERNOON = "afternoon_session"
    CLOSED = "closed"

    @property
    def is_trading(self) -> bool:
        return self in {MarketPhase.MORNING, MarketPhase.AFTERNOON}


@dataclass
class PricePoint:
    timestamp: datetime
    price: float


@dataclass
class Stock:
    symbol: str
    name: str
    previous_close: float
    limit_ratio: float = 0.1
    history_limit: int = 240
    open_price: float = field(init=False)
    current_price: float = field(init=False)
    day_high: float = field(init=False)
    day_low: float = field(init=False)
    history: Deque[PricePoint] = field(default_factory=deque, init=False)

    def __post_init__(self) -> None:
        self.open_price = self.previous_close
        self.current_price = self.previous_close
        self.day_high = self.previous_close
        self.day_low = self.previous_close
        self.history = deque(maxlen=self.history_limit)
        self.append_history(datetime.utcnow(), self.current_price)

    def append_history(self, ts: datetime, price: float) -> None:
        self.history.append(PricePoint(timestamp=ts, price=price))

    @property
    def limit_up(self) -> float:
        return round(self.previous_close * (1 + self.limit_ratio), 2)

    @property
    def limit_down(self) -> float:
        return round(self.previous_close * (1 - self.limit_ratio), 2)

    @property
    def change(self) -> float:
        return round(self.current_price - self.previous_close, 2)

    @property
    def change_percent(self) -> float:
        if self.previous_close == 0:
            return 0.0
        return round((self.current_price - self.previous_close) / self.previous_close * 100, 2)

    def to_dict(self) -> Dict[str, object]:
        return {
            "symbol": self.symbol,
            "name": self.name,
            "price": round(self.current_price, 2),
            "open": round(self.open_price, 2),
            "prev_close": round(self.previous_close, 2),
            "high": round(self.day_high, 2),
            "low": round(self.day_low, 2),
            "change": self.change,
            "change_percent": self.change_percent,
            "limit_up": self.limit_up,
            "limit_down": self.limit_down,
            "history": [
                {
                    "timestamp": point.timestamp.isoformat(),
                    "price": round(point.price, 2),
                }
                for point in list(self.history)
            ],
        }

    def update_price(self, pct_change: float, now: datetime) -> None:
        limit_up_price = self.limit_up
        limit_down_price = self.limit_down
        new_price = self.current_price * (1 + pct_change)
        new_price = min(max(new_price, limit_down_price), limit_up_price)
        new_price = round(new_price, 2)
        self.current_price = max(new_price, 0.01)
        self.day_high = max(self.day_high, self.current_price)
        self.day_low = min(self.day_low, self.current_price)
        self.append_history(now, self.current_price)

    def start_new_session(self, now: datetime) -> None:
        self.open_price = self.current_price
        self.day_high = self.current_price
        self.day_low = self.current_price
        self.append_history(now, self.current_price)

    def close_session(self) -> None:
        self.previous_close = self.current_price


class MarketClock:
    def __init__(
        self,
        tz_name: str = "Asia/Shanghai",
        morning_open: time = time(9, 30),
        morning_close: time = time(11, 30),
        afternoon_open: time = time(13, 0),
        afternoon_close: time = time(15, 0),
        tick_seconds: float = 2.0,
        simulation_speed: float = 1.0,
        force_open: bool = False,
    ) -> None:
        self.tz = pytz.timezone(tz_name)
        self.morning_open = morning_open
        self.morning_close = morning_close
        self.afternoon_open = afternoon_open
        self.afternoon_close = afternoon_close
        self.tick_seconds = tick_seconds
        self.simulation_speed = simulation_speed
        self.force_open = force_open

    def now(self) -> datetime:
        return datetime.now(self.tz)

    def is_trading_day(self, current_date: date) -> bool:
        return current_date.weekday() < 5

    def phase(self, now: Optional[datetime] = None) -> MarketPhase:
        if self.force_open:
            return MarketPhase.MORNING

        now = now or self.now()
        if not self.is_trading_day(now.date()):
            return MarketPhase.CLOSED

        current_time = now.time()
        if current_time < self.morning_open:
            return MarketPhase.PREOPEN
        if self.morning_open <= current_time < self.morning_close:
            return MarketPhase.MORNING
        if self.morning_close <= current_time < self.afternoon_open:
            return MarketPhase.MIDDAY_BREAK
        if self.afternoon_open <= current_time < self.afternoon_close:
            return MarketPhase.AFTERNOON
        return MarketPhase.CLOSED

    def status(self, now: Optional[datetime] = None) -> Dict[str, object]:
        now = now or self.now()
        phase = self.phase(now)
        if phase.is_trading:
            label = "开盘中"
        elif phase == MarketPhase.MIDDAY_BREAK:
            label = "午间休市"
        else:
            label = "休市"
        return {
            "phase": phase.value,
            "label": label,
            "timestamp": now.isoformat(),
            "countdown": self._countdown(now, phase),
        }

    def _countdown(self, now: datetime, phase: MarketPhase) -> Optional[int]:
        """Return seconds to the next market event."""
        day = now.date()
        if phase == MarketPhase.PREOPEN:
            target = datetime.combine(day, self.morning_open, tzinfo=self.tz)
        elif phase == MarketPhase.MORNING:
            target = datetime.combine(day, self.morning_close, tzinfo=self.tz)
        elif phase == MarketPhase.MIDDAY_BREAK:
            target = datetime.combine(day, self.afternoon_open, tzinfo=self.tz)
        elif phase == MarketPhase.AFTERNOON:
            target = datetime.combine(day, self.afternoon_close, tzinfo=self.tz)
        else:
            next_day = day + timedelta(days=1)
            target = datetime.combine(next_day, self.morning_open, tzinfo=self.tz)
        diff = (target - now).total_seconds()
        return max(0, int(diff))

    @property
    def sleep_interval(self) -> float:
        return max(0.2, self.tick_seconds / max(self.simulation_speed, 0.1))

    def day_closed(self, now: Optional[datetime] = None) -> bool:
        now = now or self.now()
        if self.force_open:
            return False
        if not self.is_trading_day(now.date()):
            return True
        return now.time() >= self.afternoon_close


@dataclass
class Portfolio:
    user_id: str
    cash: float = 100_000.0
    positions: Dict[str, int] = field(default_factory=dict)
    trade_history: List[Dict[str, object]] = field(default_factory=list)

    def to_view(self, stocks: Dict[str, Stock]) -> Dict[str, object]:
        holdings = []
        total_value = self.cash
        for symbol, quantity in self.positions.items():
            stock = stocks.get(symbol)
            if not stock:
                continue
            market_value = round(quantity * stock.current_price, 2)
            total_value += market_value
            holdings.append(
                {
                    "symbol": symbol,
                    "name": stock.name,
                    "quantity": quantity,
                    "price": round(stock.current_price, 2),
                    "market_value": market_value,
                }
            )
        return {
            "cash": round(self.cash, 2),
            "total_value": round(total_value, 2),
            "holdings": holdings,
            "history": self.trade_history[-50:],
        }


class Market:
    def __init__(self) -> None:
        speed = float(os.getenv("SIMULATION_SPEED", "1.0"))
        tick_seconds = float(os.getenv("MARKET_TICK_SECONDS", "2.0"))
        force_open = os.getenv("FORCE_MARKET_OPEN", "0") == "1"
        self.clock = MarketClock(simulation_speed=speed, tick_seconds=tick_seconds, force_open=force_open)
        self.stocks: Dict[str, Stock] = self._seed_stocks()
        self.accounts: Dict[str, Portfolio] = {}
        self.subscribers: Dict[str, asyncio.Queue] = {}
        self._market_task: Optional[asyncio.Task] = None
        self._current_phase: Optional[MarketPhase] = None
        self._day_opened: Optional[date] = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        if not self._market_task:
            self._market_task = asyncio.create_task(self._run_market())

    async def stop(self) -> None:
        if self._market_task:
            self._market_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._market_task
            self._market_task = None

    async def _run_market(self) -> None:
        while True:
            await self._tick()
            await asyncio.sleep(self.clock.sleep_interval)

    async def _tick(self) -> None:
        now = self.clock.now()
        phase = self.clock.phase(now)
        if phase.is_trading:
            await self._handle_open_session(now)
            await self._update_prices(now)
        else:
            await self._handle_non_trading(phase, now)
        await self._broadcast(now)
        self._current_phase = phase

    async def _handle_open_session(self, now: datetime) -> None:
        if self._current_phase and self._current_phase.is_trading:
            return
        # Starting a new trading session (morning or afternoon)
        async with self._lock:
            if self._day_opened != now.date():
                for stock in self.stocks.values():
                    stock.start_new_session(now)
                self._day_opened = now.date()

    async def _handle_non_trading(self, phase: MarketPhase, now: datetime) -> None:
        if phase == MarketPhase.CLOSED and self.clock.day_closed(now):
            if self._current_phase != MarketPhase.CLOSED:
                async with self._lock:
                    for stock in self.stocks.values():
                        stock.close_session()

    async def _update_prices(self, now: datetime) -> None:
        async with self._lock:
            for stock in self.stocks.values():
                base_volatility = 0.003
                drift = random.uniform(-0.001, 0.001)
                shock = random.gauss(0, base_volatility)
                pct_change = drift + shock
                stock.update_price(pct_change, now)

    async def _broadcast(self, now: datetime) -> None:
        if not self.subscribers:
            return
        snapshot = self.snapshot(now)
        queues = list(self.subscribers.values())
        for queue in queues:
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            await queue.put(snapshot)

    def snapshot(self, now: Optional[datetime] = None) -> Dict[str, object]:
        now = now or self.clock.now()
        return {
            "timestamp": now.isoformat(),
            "market_status": self.clock.status(now),
            "stocks": [stock.to_dict() for stock in self.stocks.values()],
        }

    def _seed_stocks(self) -> Dict[str, Stock]:
        companies = [
            ("ALIB", "阿里巴巴集团"),
            ("TENC", "腾讯控股"),
            ("BIDU", "百度科技"),
            ("JD", "京东集团"),
            ("PDD", "拼多多"),
            ("MEIT", "美团点评"),
            ("BYD", "比亚迪"),
            ("NIO", "蔚来汽车"),
            ("XPEV", "小鹏汽车"),
            ("LI", "理想汽车"),
            ("ICBC", "中国工商银行"),
            ("CCB", "中国建设银行"),
            ("ABC", "中国农业银行"),
            ("BOC", "中国银行"),
            ("PING", "中国平安"),
            ("CITS", "中信证券"),
            ("HAIR", "海尔智家"),
            ("MIDE", "美的集团"),
            ("GREE", "格力电器"),
            ("TSMC", "台积电"),
            ("SMIC", "中芯国际"),
        ]
        random.shuffle(companies)
        stock_count = random.randint(10, 20)
        selections = companies[:stock_count]
        stocks: Dict[str, Stock] = {}
        for symbol, name in selections:
            base_price = random.uniform(8, 180)
            stocks[symbol] = Stock(symbol=symbol, name=name, previous_close=round(base_price, 2))
        return dict(sorted(stocks.items()))

    def create_account(self) -> Portfolio:
        user_id = uuid.uuid4().hex
        account = Portfolio(user_id=user_id)
        self.accounts[user_id] = account
        return account

    def get_account(self, user_id: str) -> Portfolio:
        account = self.accounts.get(user_id)
        if not account:
            raise KeyError("Account not found")
        return account

    def portfolio_view(self, user_id: str) -> Dict[str, object]:
        account = self.get_account(user_id)
        return account.to_view(self.stocks)

    def execute_trade(self, user_id: str, symbol: str, quantity: int, side: str) -> Dict[str, object]:
        if quantity <= 0:
            raise ValueError("Quantity must be positive")
        account = self.get_account(user_id)
        stock = self.stocks.get(symbol)
        if not stock:
            raise ValueError("Unknown stock")
        price = stock.current_price
        cost = quantity * price
        trade_record = {
            "timestamp": datetime.utcnow().isoformat(),
            "symbol": symbol,
            "name": stock.name,
            "price": round(price, 2),
            "quantity": quantity,
            "side": side,
        }
        if side == "buy":
            if account.cash < cost:
                raise ValueError("资金不足，无法完成买入")
            account.cash -= cost
            account.positions[symbol] = account.positions.get(symbol, 0) + quantity
        elif side == "sell":
            holding = account.positions.get(symbol, 0)
            if holding < quantity:
                raise ValueError("持仓数量不足，无法卖出")
            account.positions[symbol] = holding - quantity
            account.cash += cost
            if account.positions[symbol] == 0:
                del account.positions[symbol]
        else:
            raise ValueError("Unsupported side")
        account.trade_history.append(trade_record)
        return {
            "result": "success",
            "trade": trade_record,
            "portfolio": account.to_view(self.stocks),
        }

    async def register(self, client_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        self.subscribers[client_id] = queue
        # Send immediate snapshot
        await queue.put(self.snapshot())
        return queue

    async def unregister(self, client_id: str) -> None:
        if client_id in self.subscribers:
            del self.subscribers[client_id]
