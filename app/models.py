from typing import List, Literal, Optional

from pydantic import BaseModel, Field



class AuthRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=32)
    password: str = Field(..., min_length=1, max_length=128)


class AuthResponse(BaseModel):
    user_id: str
    username: str
    token: str



class HistoryPoint(BaseModel):
    timestamp: str
    price: float


class StockView(BaseModel):
    symbol: str
    name: str
    price: float
    open: float
    prev_close: float
    high: float
    low: float
    change: float
    change_percent: float
    limit_up: float
    limit_down: float
    history: List[HistoryPoint]


class MarketStatus(BaseModel):
    phase: str
    label: str
    timestamp: str
    countdown: Optional[int]


class MarketSnapshot(BaseModel):
    timestamp: str
    market_status: MarketStatus
    stocks: List[StockView]


class PortfolioHolding(BaseModel):
    symbol: str
    name: str
    quantity: int
    price: float
    market_value: float


class TradeRecord(BaseModel):
    timestamp: str
    symbol: str
    name: str
    price: float
    quantity: int
    side: Literal["buy", "sell"]


class PortfolioView(BaseModel):
    cash: float
    total_value: float
    holdings: List[PortfolioHolding]
    history: List[TradeRecord]


class TradeRequest(BaseModel):
    symbol: str
    quantity: int
    side: Literal["buy", "sell"]


class TradeResponse(BaseModel):
    result: Literal["success"]
    trade: TradeRecord
    portfolio: PortfolioView
