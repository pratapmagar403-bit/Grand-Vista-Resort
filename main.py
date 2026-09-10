"""
FastAPI application for AI Chatbot with SQLite persistence and Gemini 3.8 Flash.
"""

import os
import json
import asyncio
import queue
import threading
from typing import Optional
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google import genai
from google.genai import types

import database

# Initialize database
database.init_db()

app = FastAPI(
    title="AI Chatbot",
    description="Fullstack AI Chatbot using Python, FastAPI, SQLite, and vanilla HTML/CSS."
)

# Enable CORS for local testing/development flexibility
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Ensure static folder exists
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")


def get_gemini_client() -> Optional[genai.Client]:
    """Retrieves Google GenAI client if API key is present."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    return genai.Client(
        api_key=api_key,
        http_options={"headers": {"User-Agent": "aistudio-build"}}
    )


# Request schemas
class CreateSessionRequest(BaseModel):
    title: Optional[str] = "New Conversation"


class UpdateSessionRequest(BaseModel):
    title: str


class ChatMessageRequest(BaseModel):
    session_id: str
    message: str
    stream: Optional[bool] = True


@app.api_route("/", methods=["GET", "HEAD"], response_class=FileResponse)
async def serve_index():
    """Serves the frontend single-page application."""
    index_file = os.path.join(os.path.dirname(__file__), "static", "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file, media_type="text/html")
    return HTMLResponse("<h1>AI Chatbot Frontend loading...</h1>", status_code=200)


@app.get("/api/health")
async def health_check():
    """Health check returning database and AI service status."""
    has_api_key = bool(os.environ.get("GEMINI_API_KEY"))
    stats = database.get_db_stats()
    return {
        "status": "healthy",
        "backend": "FastAPI (Python 3.11)",
        "database": "SQLite (WAL mode)",
        "model": "gemini-3.8-flash",
        "has_api_key": has_api_key,
        "stats": stats
    }


@app.get("/api/sessions")
async def get_sessions():
    """Lists all chat sessions stored in SQLite."""
    sessions = database.list_sessions()
    return {"sessions": sessions}


@app.post("/api/sessions")
async def create_new_session(req: CreateSessionRequest):
    """Creates a new chat session in SQLite."""
    session = database.create_session(title=req.title)
    return {"session": session}


@app.get("/api/sessions/{session_id}")
async def get_session_detail(session_id: str):
    """Retrieves a session and all its messages."""
    session = database.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    messages = database.get_messages(session_id)
    return {"session": session, "messages": messages}


@app.patch("/api/sessions/{session_id}")
async def rename_session(session_id: str, req: UpdateSessionRequest):
    """Updates session title."""
    success = database.update_session_title(session_id, req.title)
    if not success:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": "ok", "title": req.title}


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    """Deletes session and all associated messages from SQLite."""
    success = database.delete_session(session_id)
    if not success:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"status": "ok", "deleted": session_id}


@app.post("/api/sessions/{session_id}/clear")
async def clear_session(session_id: str):
    """Clears all messages within a specific session."""
    database.clear_session_messages(session_id)
    return {"status": "ok", "cleared": session_id}


@app.get("/api/export/{session_id}")
async def export_chat(session_id: str, format: str = "markdown"):
    """Exports chat session as Markdown or JSON."""
    session = database.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    messages = database.get_messages(session_id)

    if format == "json":
        return JSONResponse(content={"session": session, "messages": messages})

    # Markdown export
    lines = [f"# {session['title']}", f"*Created: {session['created_at']}*\n", "---"]
    for msg in messages:
        sender = "You" if msg["role"] == "user" else "Gemini AI"
        lines.append(f"\n### {sender} ({msg['created_at']}):\n{msg['content']}\n")

    content = "\n".join(lines)
    filename = f"chat_{session['title'][:20].replace(' ', '_')}.md"
    return Response(
        content=content,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


def generate_concise_title(text: str) -> str:
    """Generates a clean session title from the user prompt."""
    cleaned = " ".join(text.strip().split())
    if len(cleaned) <= 32:
        return cleaned
    return cleaned[:30] + "..."


@app.post("/api/chat")
async def chat_endpoint(req: ChatMessageRequest):
    """
    Handles chat message:
    1. Saves user message into SQLite
    2. Builds conversation turn history
    3. Calls Gemini 3.8 Flash model
    4. Streams chunks via Server-Sent Events (SSE)
    5. Saves full assistant response into SQLite
    """
    user_prompt = req.message.strip()
    if not user_prompt:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    session_id = req.session_id

    # Check if session exists; if not, create one
    session = database.get_session(session_id)
    new_title = None
    if not session:
        title = generate_concise_title(user_prompt)
        session = database.create_session(title=title)
        session_id = session["id"]
        new_title = title
    elif session["title"] in ("New Conversation", "Untitled Chat"):
        # Auto-update generic title on first turn
        new_title = generate_concise_title(user_prompt)
        database.update_session_title(session_id, new_title)

    # 1. Save user message in SQLite
    user_msg = database.add_message(session_id, "user", user_prompt)

    # 2. Retrieve recent chat history for context (up to last 15 messages)
    history_records = database.get_messages(session_id)
    # Exclude the message we just added so we don't duplicate it in contents
    prior_messages = history_records[:-1] if len(history_records) > 0 else []

    contents = []
    # Gemini alternating role format: user, model
    for msg in prior_messages[-14:]:
        role = "user" if msg["role"] == "user" else "model"
        contents.append(
            types.Content(
                role=role,
                parts=[types.Part.from_text(text=msg["content"])]
            )
        )

    # Append current user prompt
    contents.append(
        types.Content(
            role="user",
            parts=[types.Part.from_text(text=user_prompt)]
        )
    )

    client = get_gemini_client()

    async def event_generator():
        # Inform client about user message confirmation and any updated title
        init_payload = {
            "type": "init",
            "user_message_id": user_msg["id"],
            "session_id": session_id,
            "title": new_title
        }
        yield f"data: {json.dumps(init_payload)}\n\n"

        if not client:
            error_message = (
                "**Gemini API Key is not configured.**\n\n"
                "Please configure your `GEMINI_API_KEY` in the AI Studio Settings / Secrets panel "
                "to interact with live Gemini AI models."
            )
            # Save assistant message into SQLite even in fallback mode
            assistant_msg = database.add_message(session_id, "assistant", error_message)
            chunk_payload = {"type": "chunk", "text": error_message}
            yield f"data: {json.dumps(chunk_payload)}\n\n"
            done_payload = {
                "type": "done",
                "message_id": assistant_msg["id"],
                "session_id": session_id
            }
            yield f"data: {json.dumps(done_payload)}\n\n"
            return

        accumulated_text = []

        # Stream response using a worker thread and queue so the asyncio event loop is never blocked
        system_instruction = (
            "You are a helpful, versatile, and articulate AI assistant. "
            "Provide clear, well-structured, and accurate responses. "
            "Use Markdown formatting (headings, lists, bold text, and fenced code blocks with language tags) "
            "when it enhances readability and clarity."
        )
        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=0.7,
        )

        chunk_queue = queue.Queue()

        def stream_worker():
            try:
                response = client.models.generate_content_stream(
                    model="gemini-3.8-flash",
                    contents=contents,
                    config=config,
                )
                for chunk in response:
                    text_part = chunk.text or ""
                    if text_part:
                        chunk_queue.put(("chunk", text_part))
                chunk_queue.put(("done", None))
            except Exception as exc:
                chunk_queue.put(("error", str(exc)))

        thread = threading.Thread(target=stream_worker, daemon=True)
        thread.start()

        try:
            while True:
                # Non-blocking check using asyncio sleep
                try:
                    msg_type, val = chunk_queue.get_nowait()
                except queue.Empty:
                    if not thread.is_alive():
                        break
                    await asyncio.sleep(0.01)
                    continue

                if msg_type == "chunk":
                    accumulated_text.append(val)
                    payload = {"type": "chunk", "text": val}
                    yield f"data: {json.dumps(payload)}\n\n"
                elif msg_type == "done":
                    break
                elif msg_type == "error":
                    err_text = f"**Error encountered while generating response:** `{val}`"
                    assistant_msg = database.add_message(session_id, "assistant", err_text)
                    err_payload = {"type": "error", "error": val, "text": err_text}
                    yield f"data: {json.dumps(err_payload)}\n\n"
                    done_payload = {
                        "type": "done",
                        "message_id": assistant_msg["id"],
                        "session_id": session_id
                    }
                    yield f"data: {json.dumps(done_payload)}\n\n"
                    return

            full_text = "".join(accumulated_text).strip()
            if not full_text:
                full_text = "I received your message, but no response text was generated."

            # Save assistant response into SQLite
            assistant_msg = database.add_message(session_id, "assistant", full_text)

            done_payload = {
                "type": "done",
                "message_id": assistant_msg["id"],
                "session_id": session_id,
                "title": new_title
            }
            yield f"data: {json.dumps(done_payload)}\n\n"

        except Exception as e:
            err_text = f"**Stream processing error:** `{str(e)}`"
            assistant_msg = database.add_message(session_id, "assistant", err_text)
            err_payload = {"type": "error", "error": str(e), "text": err_text}
            yield f"data: {json.dumps(err_payload)}\n\n"
            done_payload = {
                "type": "done",
                "message_id": assistant_msg["id"],
                "session_id": session_id
            }
            yield f"data: {json.dumps(done_payload)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="AI Chatbot Server")
    parser.add_argument("--host", default="0.0.0.0", help="Host interface")
    parser.add_argument("--port", type=int, default=3000, help="Port number")
    args, _ = parser.parse_known_args()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
