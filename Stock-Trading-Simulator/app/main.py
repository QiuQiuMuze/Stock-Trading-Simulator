import asyncio
import contextlib
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .market import Market
from .models import MarketSnapshot, PortfolioView, SessionResponse, TradeRequest, TradeResponse

app = FastAPI(title="股票模拟交易平台", version="0.1.0")
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

market = Market()


@app.on_event("startup")
async def on_startup() -> None:
    await market.start()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await market.stop()


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/api/session", response_model=SessionResponse)
async def create_session() -> SessionResponse:
    account = market.create_account()
    return SessionResponse(user_id=account.user_id)


async def get_user_id(x_user_id: Optional[str] = Header(default=None)) -> str:
    if not x_user_id:
        raise HTTPException(status_code=400, detail="缺少用户身份标识，请先创建会话")
    if x_user_id not in market.accounts:
        raise HTTPException(status_code=404, detail="未找到对应的模拟账户")
    return x_user_id


@app.get("/api/stocks", response_model=MarketSnapshot)
async def list_stocks() -> MarketSnapshot:
    return MarketSnapshot.parse_obj(market.snapshot())


@app.get("/api/portfolio", response_model=PortfolioView)
async def get_portfolio(user_id: str = Depends(get_user_id)) -> PortfolioView:
    return PortfolioView.parse_obj(market.portfolio_view(user_id))


@app.post("/api/trade", response_model=TradeResponse)
async def trade(request: TradeRequest, user_id: str = Depends(get_user_id)) -> TradeResponse:
    try:
        result = market.execute_trade(user_id=user_id, symbol=request.symbol, quantity=request.quantity, side=request.side)
        return TradeResponse.parse_obj(result)
    except ValueError as exc:  # business rule violation
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError:
        raise HTTPException(status_code=404, detail="未找到账户")


@app.websocket("/ws/quotes")
async def websocket_quotes(websocket: WebSocket) -> None:
    await websocket.accept()
    client_id = id(websocket)
    queue = await market.register(str(client_id))
    try:
        consumer = asyncio.create_task(_consume(queue, websocket))
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        consumer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await consumer
        await market.unregister(str(client_id))


async def _consume(queue: asyncio.Queue, websocket: WebSocket) -> None:
    try:
        while True:
            snapshot = await queue.get()
            await websocket.send_json(snapshot)
    except asyncio.CancelledError:
        return
