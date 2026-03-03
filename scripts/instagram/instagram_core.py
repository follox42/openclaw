#!/usr/bin/env python3
"""
Instagram scraper core — Playwright stealth + API response interception.
No login required for public profiles.

Usage:
  python3 instagram_core.py --action profile  --username <user>
  python3 instagram_core.py --action post      --url <post_url>
  python3 instagram_core.py --action feed      --username <user> [--limit 10]
  python3 instagram_core.py --action search    --query <q>
  python3 instagram_core.py --action hashtag   --tag <hashtag>
  python3 instagram_core.py --action download  --url <url> --output <path>
"""

import argparse
import asyncio
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote_plus

# ─── Constants ───────────────────────────────────────────────────────────────

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]

COOKIES_PATH = os.environ.get(
    "INSTAGRAM_COOKIES_PATH",
    os.path.expanduser("~/.clawdbot/instagram_cookies.json"),
)

DEFAULT_TIMEOUT = 25_000  # ms
DEFAULT_WAIT = 3.0        # seconds after navigation
INSTAGRAM_BASE = "https://www.instagram.com"


# ─── Browser Context ─────────────────────────────────────────────────────────

class InstagramBrowser:
    """Playwright stealth browser for Instagram scraping."""

    def __init__(self, headless: bool = True):
        self.headless = headless
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None
        self._ua = random.choice(USER_AGENTS)

    async def __aenter__(self):
        await self.launch()
        return self

    async def __aexit__(self, *_):
        await self.close()

    async def launch(self):
        from playwright.async_api import async_playwright
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(
            headless=self.headless,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
                "--disable-extensions",
            ],
        )
        self._context = await self._browser.new_context(
            user_agent=self._ua,
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            timezone_id="Europe/Paris",
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
            },
        )

        # Apply playwright-stealth if available
        try:
            from playwright_stealth import Stealth
            await Stealth().apply_stealth_async(self._context)
        except Exception:
            pass

        # Load saved cookies if present
        await self._load_cookies()

        self._page = await self._context.new_page()

        # Block heavy assets to speed up loading
        await self._page.route(
            "**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,svg}",
            lambda route: route.abort() if "cdninstagram" not in route.request.url else route.continue_(),
        )

        return self._page

    async def _load_cookies(self) -> bool:
        if not os.path.exists(COOKIES_PATH):
            return False
        try:
            with open(COOKIES_PATH, "r") as f:
                cookies = json.load(f)
            if isinstance(cookies, list) and cookies:
                await self._context.add_cookies(cookies)
                return True
        except Exception as e:
            print(f"[instagram] Cookie load failed: {e}", file=sys.stderr)
        return False

    async def save_cookies(self) -> bool:
        if not self._context:
            return False
        try:
            cookies = await self._context.cookies(INSTAGRAM_BASE)
            os.makedirs(os.path.dirname(COOKIES_PATH), exist_ok=True)
            with open(COOKIES_PATH, "w") as f:
                json.dump(cookies, f, indent=2)
            return True
        except Exception:
            return False

    async def goto(self, path: str) -> Any:
        url = f"{INSTAGRAM_BASE}{path}" if path.startswith("/") else path
        await self._page.goto(url, wait_until="domcontentloaded", timeout=DEFAULT_TIMEOUT)
        await asyncio.sleep(DEFAULT_WAIT + random.uniform(0, 1.5))
        return self._page

    async def close(self):
        try:
            if self._browser:
                await self._browser.close()
        except Exception:
            pass
        try:
            if self._pw:
                await self._pw.stop()
        except Exception:
            pass


# ─── Intercepted-response helpers ────────────────────────────────────────────

async def intercept_goto(browser: InstagramBrowser, path: str, url_filter_fn) -> dict:
    """Navigate and collect first matching API response."""
    captured: dict = {}

    async def on_response(response):
        if url_filter_fn(response.url):
            try:
                body = await response.json()
                captured.update(body)
            except Exception:
                pass

    browser._page.on("response", on_response)
    await browser.goto(path)
    browser._page.remove_listener("response", on_response)
    return captured


# ─── Actions ─────────────────────────────────────────────────────────────────

async def action_profile(username: str) -> dict:
    """Get public profile data + 12 most recent posts."""
    async with InstagramBrowser() as browser:
        captured = await intercept_goto(
            browser,
            f"/{username}/",
            lambda url: "web_profile_info" in url,
        )

        user = captured.get("data", {}).get("user") or {}
        if not user:
            # Try meta tags fallback
            page = browser._page
            meta = await page.evaluate("""() => {
                const og = (n) => document.querySelector(`meta[property="${n}"]`)?.content || '';
                const nm = (n) => document.querySelector(`meta[name="${n}"]`)?.content || '';
                return {
                    title: og('og:title') || nm('title'),
                    description: og('og:description') || nm('description'),
                    image: og('og:image'),
                };
            }""")
            return {"ok": False, "error": "profile_not_found_in_api", "meta": meta}

        # Extract recent posts
        media_edges = (
            user.get("edge_owner_to_timeline_media", {}).get("edges", [])
            or user.get("edge_felix_video_timeline", {}).get("edges", [])
        )
        posts = []
        for edge in media_edges[:12]:
            node = edge.get("node", {})
            caption_edges = node.get("edge_media_to_caption", {}).get("edges", [])
            caption = caption_edges[0].get("node", {}).get("text", "") if caption_edges else ""
            posts.append({
                "shortcode": node.get("shortcode"),
                "url": f"https://www.instagram.com/p/{node.get('shortcode', '')}/",
                "type": node.get("__typename", ""),
                "timestamp": node.get("taken_at_timestamp"),
                "likes": node.get("edge_liked_by", {}).get("count") or node.get("edge_media_preview_like", {}).get("count"),
                "comments": node.get("edge_media_to_comment", {}).get("count"),
                "caption": caption[:200] if caption else "",
                "is_video": node.get("is_video", False),
                "video_views": node.get("video_view_count"),
                "thumbnail": node.get("display_url", ""),
            })

        return {
            "ok": True,
            "id": user.get("id"),
            "username": user.get("username"),
            "full_name": user.get("full_name"),
            "biography": user.get("biography", ""),
            "website": user.get("external_url"),
            "followers": user.get("edge_followed_by", {}).get("count"),
            "following": user.get("edge_follow", {}).get("count"),
            "media_count": user.get("edge_owner_to_timeline_media", {}).get("count"),
            "profile_pic_url": user.get("profile_pic_url_hd") or user.get("profile_pic_url"),
            "is_verified": user.get("is_verified", False),
            "is_private": user.get("is_private", False),
            "is_business": user.get("is_business_account", False),
            "category": user.get("business_category_name"),
            "recent_posts": posts,
        }


async def action_post(url: str) -> dict:
    """Get single post data."""
    # Normalize URL to shortcode
    m = re.search(r"/(?:p|reel|tv)/([A-Za-z0-9_-]+)", url)
    shortcode = m.group(1) if m else None

    async with InstagramBrowser() as browser:
        captured_graphql: list[dict] = []

        async def on_response(response):
            if "graphql" in response.url or "api/v1/media" in response.url:
                try:
                    body = await response.json()
                    captured_graphql.append(body)
                except Exception:
                    pass

        browser._page.on("response", on_response)
        await browser.goto(url if url.startswith("http") else f"/p/{shortcode}/")
        browser._page.remove_listener("response", on_response)

        # Try meta tags first (most reliable)
        page = browser._page
        meta = await page.evaluate("""() => {
            const og = (n) => document.querySelector(`meta[property="${n}"]`)?.content || '';
            const desc = og('og:description');
            const title = og('og:title');
            return { description: desc, title, image: og('og:image'), video: og('og:video') };
        }""")

        # Parse likes/comments from description: "100K Likes, 1,234 Comments"
        desc = meta.get("description", "")
        likes_m = re.search(r"([\d,KMBkmb.]+)\s+[Ll]ike", desc)
        comments_m = re.search(r"([\d,KMBkmb.]+)\s+[Cc]omment", desc)

        # Try to get caption from page DOM
        caption = await page.evaluate("""() => {
            const el = document.querySelector('h1') ||
                       document.querySelector('[data-testid="post-comment-root-0"] span') ||
                       document.querySelector('article span');
            return el?.innerText?.trim() || '';
        }""")

        # Get hashtags from caption
        hashtags = re.findall(r"#(\w+)", caption or desc)

        result = {
            "ok": True,
            "url": url,
            "shortcode": shortcode,
            "title": meta.get("title", ""),
            "caption": caption or "",
            "likes": likes_m.group(1) if likes_m else None,
            "comments": comments_m.group(1) if comments_m else None,
            "hashtags": hashtags[:20],
            "thumbnail": meta.get("image", ""),
            "is_video": bool(meta.get("video")),
            "video_url": meta.get("video", "") or None,
        }

        # Enrich from GraphQL if available
        for gql in captured_graphql:
            media = (
                gql.get("data", {}).get("shortcode_media")
                or gql.get("data", {}).get("xdt_shortcode_media")
                or {}
            )
            if media:
                caption_edges = media.get("edge_media_to_caption", {}).get("edges", [])
                gql_caption = caption_edges[0].get("node", {}).get("text", "") if caption_edges else ""
                result.update({
                    "id": media.get("id"),
                    "caption": gql_caption or result["caption"],
                    "likes": media.get("edge_media_preview_like", {}).get("count") or media.get("edge_liked_by", {}).get("count") or result["likes"],
                    "comments": media.get("edge_media_to_comment", {}).get("count") or result["comments"],
                    "timestamp": media.get("taken_at_timestamp"),
                    "owner_username": media.get("owner", {}).get("username"),
                    "owner_id": media.get("owner", {}).get("id"),
                    "hashtags": re.findall(r"#(\w+)", gql_caption or ""),
                    "is_video": media.get("is_video", result["is_video"]),
                    "video_views": media.get("video_view_count"),
                })
                break

        return result


async def action_feed(username: str, limit: int = 10) -> dict:
    """Get last N posts from a user's profile."""
    profile = await action_profile(username)
    if not profile.get("ok"):
        return profile

    posts = profile.get("recent_posts", [])

    # If we need more than what's on the profile page, scroll/paginate
    # For now return what we have (up to 12 from the API)
    return {
        "ok": True,
        "username": username,
        "full_name": profile.get("full_name"),
        "followers": profile.get("followers"),
        "media_count": profile.get("media_count"),
        "posts": posts[:limit],
        "returned": min(len(posts), limit),
    }


async def action_hashtag(tag: str) -> dict:
    """Get hashtag info + top posts."""
    tag = tag.lstrip("#")

    async with InstagramBrowser() as browser:
        captured: list[dict] = []
        page = browser._page

        async def on_response(response):
            url = response.url
            # Intercept graphql and api/v1/tags calls
            if ("graphql" in url or "api/v1/tags" in url or "tag" in url.lower()) and "instagram.com" in url:
                try:
                    ct = response.headers.get("content-type", "")
                    if "json" in ct:
                        body = await response.json()
                        captured.append(body)
                except Exception:
                    pass

        page.on("response", on_response)
        await browser.goto(f"/explore/tags/{quote_plus(tag)}/")
        page.remove_listener("response", on_response)

        # Meta tags for hashtag count
        meta = await page.evaluate("""() => {
            const og = (n) => document.querySelector(`meta[property="${n}"]`)?.content || '';
            const nm = (n) => document.querySelector(`meta[name="${n}"]`)?.content || '';
            return {
                title: og('og:title') || nm('title'),
                description: og('og:description') || nm('description'),
            };
        }""")

        # Extract post count from description: "22.3M Posts"
        desc = meta.get("description", "")
        count_m = re.search(r"([\d.,]+\s*[KMBkmb]?)\s*[Pp]osts?", desc)
        post_count = count_m.group(1).strip() if count_m else None

        # Get top post links from page DOM
        top_posts = await page.evaluate("""() => {
            const links = [...document.querySelectorAll('a[href*="/p/"]')];
            return links.slice(0, 9).map(a => ({
                url: a.href,
                shortcode: (a.href.match(/\\/p\\/([A-Za-z0-9_-]+)/) || [])[1] || null,
                img: a.querySelector('img')?.src || null,
                alt: a.querySelector('img')?.alt || null,
            })).filter(p => p.shortcode);
        }""")

        # Parse post count from graphql if available
        gql_count = None
        gql_posts = []
        for item in captured:
            data = item.get("data", {})
            hashtag_obj = (
                data.get("hashtag") or
                data.get("data", {}).get("hashtag") or
                item.get("hashtag") or
                {}
            )
            if hashtag_obj:
                gql_count = (
                    hashtag_obj.get("edge_hashtag_to_media", {}).get("count") or
                    hashtag_obj.get("media_count")
                )
                edges = (
                    hashtag_obj.get("edge_hashtag_to_media", {}).get("edges", []) or
                    hashtag_obj.get("edge_hashtag_to_top_posts", {}).get("edges", [])
                )
                for edge in edges[:9]:
                    node = edge.get("node", {})
                    sc = node.get("shortcode")
                    if sc:
                        gql_posts.append({
                            "shortcode": sc,
                            "url": f"https://www.instagram.com/p/{sc}/",
                            "likes": node.get("edge_liked_by", {}).get("count") or node.get("edge_media_preview_like", {}).get("count"),
                            "comments": node.get("edge_media_to_comment", {}).get("count"),
                            "is_video": node.get("is_video", False),
                        })
                break

        # Try to parse volume from page title: "Tag • 22.3M reels on Instagram"
        title_str = meta.get("title", "")
        volume_m = re.search(r"([\d.,]+\s*[KMBkmb])\s*(posts?|reels?|videos?)", title_str, re.IGNORECASE)
        volume_from_title = volume_m.group(0) if volume_m else None

        return {
            "ok": True,
            "hashtag": tag,
            "post_count": gql_count or post_count or volume_from_title,
            "title": title_str,
            "top_posts": gql_posts or top_posts[:9],
            "note": "Login with cookies enables richer hashtag data (top posts, exact counts)" if not gql_posts else None,
        }


async def action_search(query: str) -> dict:
    """Search Instagram for accounts and hashtags."""
    async with InstagramBrowser() as browser:
        captured: list[dict] = []
        page = browser._page

        async def on_response(response):
            url = response.url
            if ("search" in url.lower() or "topsearch" in url.lower()) and "instagram.com" in url:
                try:
                    ct = response.headers.get("content-type", "")
                    if "json" in ct:
                        body = await response.json()
                        captured.append(body)
                except Exception:
                    pass

        page.on("response", on_response)

        # First: navigate to Instagram to get cookies / session
        await browser.goto("/")
        await asyncio.sleep(1)

        # Then trigger search via the XHR API endpoint using page.evaluate fetch
        try:
            search_api_url = f"https://www.instagram.com/web/search/topsearch/?context=blended&query={quote_plus(query)}&rank_token=0.5&include_reel=true"
            api_result = await page.evaluate(f"""async () => {{
                try {{
                    const r = await fetch('{search_api_url}', {{
                        credentials: 'include',
                        headers: {{ 'X-Requested-With': 'XMLHttpRequest' }}
                    }});
                    if (r.ok) return await r.json();
                    return null;
                }} catch(e) {{
                    return null;
                }}
            }}""")
            if api_result:
                captured.insert(0, api_result)
        except Exception:
            pass

        page.remove_listener("response", on_response)

        # Parse results
        search_results: list[dict] = []
        hashtag_results: list[dict] = []

        for item in captured:
            users = item.get("users", [])
            hashtags_list = item.get("hashtags", [])

            for u in users:
                user = u.get("user", u)
                uname = user.get("username", "")
                if uname:
                    search_results.append({
                        "type": "account",
                        "username": uname,
                        "full_name": user.get("full_name", ""),
                        "followers": user.get("follower_count"),
                        "is_verified": user.get("is_verified", False),
                        "is_private": user.get("is_private", False),
                        "url": f"https://www.instagram.com/{uname}/",
                    })

            for h in hashtags_list:
                ht = h.get("hashtag", h)
                hname = ht.get("name", "")
                if hname:
                    hashtag_results.append({
                        "type": "hashtag",
                        "name": hname,
                        "media_count": ht.get("media_count"),
                        "url": f"https://www.instagram.com/explore/tags/{hname}/",
                    })

        if not search_results and not hashtag_results:
            return {
                "ok": True,
                "query": query,
                "accounts": [],
                "hashtags": [],
                "note": "No results found. Search requires authentication for full results. Use profile action to look up a specific account.",
            }

        return {
            "ok": True,
            "query": query,
            "accounts": search_results[:10],
            "hashtags": hashtag_results[:10],
        }


async def action_download(url: str, output: str) -> dict:
    """Download image or video from Instagram post/reel."""
    # Method 1: Try igram.world or similar free download API
    import urllib.request

    post_data = await action_post(url)
    if not post_data.get("ok"):
        return {"ok": False, "error": "could_not_fetch_post_info"}

    shortcode = post_data.get("shortcode")
    if not shortcode:
        return {"ok": False, "error": "no_shortcode_found"}

    os.makedirs(os.path.dirname(os.path.abspath(output)) or ".", exist_ok=True)

    # Method 1: instagramdownloader API (no key needed)
    async with InstagramBrowser() as browser:
        captured: list[dict] = []

        async def on_response(response):
            content_type = response.headers.get("content-type", "")
            if "image" in content_type or "video" in content_type:
                # Direct media hit — capture URL
                if "cdninstagram.com" in response.url or "fbcdn.net" in response.url:
                    captured.append({"media_url": response.url, "type": content_type})

        browser._page.on("response", on_response)
        await browser.goto(url if url.startswith("http") else f"/p/{shortcode}/")
        browser._page.remove_listener("response", on_response)

        # Try to get direct media src
        page = browser._page
        media_src = await page.evaluate("""() => {
            const vid = document.querySelector('video');
            if (vid) return { type: 'video', url: vid.src || vid.querySelector('source')?.src || '' };
            const img = document.querySelector('article img[srcset], article img[src*="cdninstagram"]');
            if (img) return { type: 'image', url: img.srcset?.split(',').pop()?.trim()?.split(' ')[0] || img.src || '' };
            return null;
        }""")

        if media_src and media_src.get("url"):
            media_url = media_src["url"]
            media_type = media_src["type"]
            ext = ".mp4" if media_type == "video" else ".jpg"
            if not output.endswith(ext):
                output = output + ext

            try:
                response = await page.request.get(media_url)
                if response.ok:
                    body = await response.body()
                    with open(output, "wb") as f:
                        f.write(body)
                    return {
                        "ok": True,
                        "path": output,
                        "type": media_type,
                        "size_bytes": len(body),
                        "source_url": media_url,
                    }
            except Exception as e:
                pass

        # Try captured CDN responses
        for item in captured:
            if "cdninstagram" in item.get("media_url", ""):
                return {
                    "ok": False,
                    "error": "media_requires_manual_save",
                    "media_url": item["media_url"],
                    "hint": "Instagram requires authentication for downloads",
                }

    return {
        "ok": False,
        "error": "download_failed",
        "hint": "Login with cookies to enable downloads",
        "shortcode": shortcode,
    }


# ─── CLI Entry Point ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Instagram scraper (OpenClaw native tool)")
    parser.add_argument("--action", required=True, choices=["profile", "post", "feed", "search", "hashtag", "download"])
    parser.add_argument("--username", default="")
    parser.add_argument("--url", default="")
    parser.add_argument("--query", default="")
    parser.add_argument("--tag", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()

    try:
        action = args.action
        if action == "profile":
            if not args.username:
                raise ValueError("--username required for profile action")
            result = asyncio.run(action_profile(args.username))
        elif action == "post":
            if not args.url:
                raise ValueError("--url required for post action")
            result = asyncio.run(action_post(args.url))
        elif action == "feed":
            if not args.username:
                raise ValueError("--username required for feed action")
            result = asyncio.run(action_feed(args.username, args.limit))
        elif action == "search":
            if not args.query:
                raise ValueError("--query required for search action")
            result = asyncio.run(action_search(args.query))
        elif action == "hashtag":
            if not args.tag:
                raise ValueError("--tag required for hashtag action")
            result = asyncio.run(action_hashtag(args.tag))
        elif action == "download":
            if not args.url or not args.output:
                raise ValueError("--url and --output required for download action")
            result = asyncio.run(action_download(args.url, args.output))
        else:
            result = {"ok": False, "error": f"Unknown action: {action}"}

        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0 if result.get("ok", True) else 1)

    except KeyboardInterrupt:
        print(json.dumps({"ok": False, "error": "interrupted"}))
        sys.exit(130)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "type": type(e).__name__}))
        sys.exit(1)


if __name__ == "__main__":
    main()
