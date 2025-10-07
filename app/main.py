import asyncio
import contextlib
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .market import Market
from .models import (
    AuthRequest,
    AuthResponse,
    MarketSnapshot,
    PortfolioView,
    StockView,
    TradeRequest,
    TradeResponse,
)
from .storage import AuthenticationError, Storage, UserAlreadyExists

app = FastAPI(title="股票模拟交易平台", version="0.2.0")
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

storage = Storage()
market = Market(storage=storage)


@app.on_event("startup")
async def on_startup() -> None:
    await market.start()


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await market.stop()


@app.get("/", response_class=HTMLResponse)
async def login_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("login.html", {"request": request})


@app.get("/register", response_class=HTMLResponse)
async def register_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("register.html", {"request": request})


@app.get("/app", response_class=HTMLResponse)
async def app_page(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("app.html", {"request": request})


@app.get("/stocks/{symbol}", response_class=HTMLResponse)
async def stock_page(symbol: str, request: Request) -> HTMLResponse:
    stock = market.get_stock(symbol)
    if not stock:
        raise HTTPException(status_code=404, detail="未找到对应的股票")
    return templates.TemplateResponse(
        "stock_detail.html",
        {"request": request, "symbol": stock["symbol"], "name": stock["name"]},
    )


async def get_current_session(x_session_token: Optional[str] = Header(default=None)) -> tuple[str, str]:
    if not x_session_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="缺少登录凭证，请先登录")
    user_id = storage.resolve_session(x_session_token)
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录状态已失效，请重新登录")
    if not storage.user_exists(user_id):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="账号不存在或已注销")
    try:
        market.ensure_account(user_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="未找到对应的模拟账户") from exc
    return user_id, x_session_token


@app.post("/api/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(payload: AuthRequest) -> AuthResponse:
    try:
        user = storage.create_user(payload.username, payload.password)
    except UserAlreadyExists as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    market.ensure_account(user["user_id"])
    token = storage.create_session(user["user_id"])
    return AuthResponse(**user, token=token)


@app.post("/api/login", response_model=AuthResponse)
async def login(payload: AuthRequest) -> AuthResponse:
    try:
        user = storage.authenticate(payload.username, payload.password)
    except AuthenticationError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    market.ensure_account(user["user_id"])
    token = storage.create_session(user["user_id"])
    return AuthResponse(**user, token=token)


@app.get("/api/profile", response_model=AuthResponse)
async def profile(session: tuple[str, str] = Depends(get_current_session)) -> AuthResponse:
    user_id, token = session
    user = storage.get_user(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="未找到用户信息")
    return AuthResponse(**user, token=token)


@app.get("/api/stocks", response_model=MarketSnapshot)
async def list_stocks() -> MarketSnapshot:
    return MarketSnapshot.parse_obj(market.snapshot())


@app.get("/api/stocks/{symbol}", response_model=StockView)
async def get_stock(symbol: str) -> StockView:
    stock = market.get_stock(symbol)
    if not stock:
        raise HTTPException(status_code=404, detail="未找到对应的股票")
    return StockView.parse_obj(stock)


@app.get("/api/portfolio", response_model=PortfolioView)
async def get_portfolio(session: tuple[str, str] = Depends(get_current_session)) -> PortfolioView:
    user_id, _ = session
    return PortfolioView.parse_obj(market.portfolio_view(user_id))


@app.post("/api/trade", response_model=TradeResponse)
async def trade(request: TradeRequest, session: tuple[str, str] = Depends(get_current_session)) -> TradeResponse:
    try:
        user_id, _ = session
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


@app.post("/api/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(session: tuple[str, str] = Depends(get_current_session)) -> Response:
    _, token = session
    storage.delete_session(token)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
