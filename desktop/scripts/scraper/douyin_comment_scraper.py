# -*- coding: utf-8 -*-
"""
抖音评论爬虫 v2
- 通过 Selenium 获取 cookie，然后用抖音内部 API 爬取
- 搜索视频列表 + 爬取评论
- 反爬策略：undetected-chromedriver、随机延迟、cookie轮换等
- 输出：JSON 文件 + CSV 文件

使用方法：
    pip install undetected-chromedriver selenium pandas requests
    python douyin_comment_scraper.py
"""

import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
import time
import random
import json
import csv
import os
import re
import hashlib
import requests
from datetime import datetime
from urllib.parse import quote


# ==================== 配置 ====================
KEYWORD = "比基尼"
TARGET_VIDEO_COUNT = 100
COMMENTS_PER_VIDEO = 10
OUTPUT_DIR = os.path.join(os.path.expanduser("~"), "Desktop", "douyin_comments")
LOGIN_WAIT_SECONDS = 60
COOKIE_FILE = os.path.join(OUTPUT_DIR, "douyin_cookies.json")
MAX_RETRIES = 3
# ==============================================


def random_sleep(min_s=2.0, max_s=5.0):
    time.sleep(random.uniform(min_s, max_s))


def setup_driver():
    options = uc.ChromeOptions()
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--disable-infobars")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--no-sandbox")
    options.add_argument("--window-size=1920,1080")
    options.add_argument("--lang=zh-CN")
    driver = uc.Chrome(options=options, version_main=147)
    driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
        "source": """
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
            Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en']});
            window.chrome = {runtime: {}};
        """
    })
    return driver


def save_cookies(driver):
    cookies = driver.get_cookies()
    os.makedirs(os.path.dirname(COOKIE_FILE), exist_ok=True)
    with open(COOKIE_FILE, "w", encoding="utf-8") as f:
        json.dump(cookies, f, ensure_ascii=False, indent=2)
    print(f"[OK] Cookies saved to {COOKIE_FILE}")


def load_cookies(driver):
    if not os.path.exists(COOKIE_FILE):
        return False
    try:
        with open(COOKIE_FILE, "r", encoding="utf-8") as f:
            cookies = json.load(f)
        driver.get("https://www.douyin.com")
        random_sleep(2, 4)
        for cookie in cookies:
            try:
                driver.add_cookie(cookie)
            except Exception:
                pass
        print("[OK] Cookies loaded")
        return True
    except Exception as e:
        print(f"[!] Failed to load cookies: {e}")
        return False


def wait_for_login(driver):
    print("\n" + "=" * 60)
    print("  Please login to Douyin in the browser window")
    print(f"  Waiting {LOGIN_WAIT_SECONDS} seconds...")
    print("=" * 60 + "\n")
    driver.get("https://www.douyin.com")
    random_sleep(3, 5)
    for i in range(LOGIN_WAIT_SECONDS, 0, -5):
        print(f"  Remaining: {i} seconds...", end="\r")
        time.sleep(5)
    save_cookies(driver)
    print("\n[OK] Login wait finished, continuing...\n")


def get_cookies_from_driver(driver):
    """从 Selenium driver 提取 cookies 转为 requests 格式"""
    selenium_cookies = driver.get_cookies()
    cookie_dict = {}
    for c in selenium_cookies:
        cookie_dict[c['name']] = c['value']
    return cookie_dict


def get_common_headers(driver):
    """获取通用请求头"""
    ua = driver.execute_script("return navigator.userAgent;")
    return {
        "User-Agent": ua,
        "Referer": "https://www.douyin.com/",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Origin": "https://www.douyin.com",
    }


def extract_video_ids_from_page(driver):
    """从搜索结果页面提取视频ID"""
    video_ids = set()
    
    # 方法1: 从页面源码中提取视频ID
    page_source = driver.page_source
    
    # 匹配 /video/xxxxx 模式
    patterns = [
        r'/video/(\d{15,25})',
        r'"aweme_id"\s*:\s*"(\d{15,25})"',
        r'"video_id"\s*:\s*"(\d{15,25})"',
        r'video/(\d{15,25})',
        r'"id"\s*:\s*"(\d{15,25})"',
    ]
    
    for pattern in patterns:
        matches = re.findall(pattern, page_source)
        for m in matches:
            if len(m) >= 15:
                video_ids.add(m)
    
    # 方法2: 从 a 标签 href 提取
    try:
        links = driver.find_elements(By.TAG_NAME, 'a')
        for link in links:
            href = link.get_attribute("href") or ""
            match = re.search(r'/video/(\d{15,25})', href)
            if match:
                video_ids.add(match.group(1))
    except Exception:
        pass
    
    # 方法3: 从所有可点击元素中提取
    try:
        elements = driver.find_elements(By.CSS_SELECTOR, '[data-e2e*="video"], [class*="video"], [class*="Video"]')
        for elem in elements:
            try:
                href = elem.get_attribute("href") or elem.get_attribute("data-video-id") or ""
                match = re.search(r'(\d{15,25})', href)
                if match:
                    video_ids.add(match.group(1))
            except Exception:
                pass
    except Exception:
        pass
    
    return video_ids


def search_videos_via_browser(driver, keyword):
    """通过浏览器搜索视频"""
    encoded_keyword = quote(keyword)
    search_url = f"https://www.douyin.com/search/{encoded_keyword}?type=video"
    print(f"[->] Searching: {keyword}")
    print(f"     URL: {search_url}")
    
    driver.get(search_url)
    random_sleep(5, 8)
    
    # 截图保存用于调试
    screenshot_path = os.path.join(OUTPUT_DIR, "search_page.png")
    try:
        driver.save_screenshot(screenshot_path)
        print(f"     Screenshot saved: {screenshot_path}")
    except Exception:
        pass
    
    all_video_ids = set()
    scroll_count = 0
    max_scrolls = 60
    
    while len(all_video_ids) < TARGET_VIDEO_COUNT and scroll_count < max_scrolls:
        scroll_count += 1
        
        # 提取当前页面的视频ID
        new_ids = extract_video_ids_from_page(driver)
        before_count = len(all_video_ids)
        all_video_ids.update(new_ids)
        after_count = len(all_video_ids)
        
        print(f"  [Scroll {scroll_count}] Found {after_count} video IDs (+{after_count - before_count} new)")
        
        if len(all_video_ids) >= TARGET_VIDEO_COUNT:
            break
        
        # 滚动加载更多
        driver.execute_script("window.scrollBy(0, window.innerHeight * 0.8);")
        random_sleep(2, 4)
        
        # 偶尔向上滚一点
        if random.random() < 0.1:
            driver.execute_script(f"window.scrollBy(0, -{random.randint(100, 300)});")
            random_sleep(1, 2)
        
        # 如果连续5次没有新内容，尝试其他方式
        if scroll_count > 10 and after_count == before_count:
            # 尝试点击"加载更多"按钮
            try:
                more_btn = driver.find_element(By.CSS_SELECTOR, '[class*="load-more"], [class*="LoadMore"], button[class*="more"]')
                more_btn.click()
                random_sleep(3, 5)
            except Exception:
                pass
    
    video_id_list = list(all_video_ids)[:TARGET_VIDEO_COUNT]
    print(f"[OK] Collected {len(video_id_list)} video IDs")
    return video_id_list


def search_videos_via_api(driver, keyword):
    """通过抖音 API 搜索视频（备用方案）"""
    print(f"[->] Trying API search for: {keyword}")
    
    cookies = get_cookies_from_driver(driver)
    headers = get_common_headers(driver)
    
    # 获取 ttwid cookie
    ttwid = cookies.get("ttwid", "")
    if not ttwid:
        print("  [!] No ttwid cookie found, trying to get one...")
        try:
            resp = requests.get("https://tt.ttwid.cn/", headers=headers, timeout=10)
            for cookie in resp.cookies:
                if cookie.name == "ttwid":
                    ttwid = cookie.value
                    cookies["ttwid"] = ttwid
                    break
        except Exception:
            pass
    
    all_video_ids = []
    offset = 0
    count = 20  # 每页数量
    
    while len(all_video_ids) < TARGET_VIDEO_COUNT:
        try:
            api_url = "https://www.douyin.com/aweme/v1/web/search/item/"
            params = {
                "keyword": keyword,
                "search_channel": "aweme_video_web",
                "sort_type": 0,
                "publish_time": 0,
                "offset": offset,
                "count": count,
                "search_source": "normal_search",
                "query_correct_type": 1,
                "is_filter_search": 0,
                "from_group_id": "",
                "offset_search_id": "",
                "need_filter_settings": 0,
                "list_type": "single",
                "search_id": "",
                "cookie_enabled": "true",
                "platform": "PC",
                "device_platform": "webapp",
                "aid": "6383",
                "channel": "channel_pc_web",
            }
            
            resp = requests.get(api_url, params=params, cookies=cookies, headers=headers, timeout=15)
            
            if resp.status_code == 200:
                data = resp.json()
                items = data.get("data", [])
                if not items:
                    print(f"  [!] API returned no items at offset {offset}")
                    break
                
                for item in items:
                    aweme_id = item.get("aweme_id", "")
                    if aweme_id:
                        all_video_ids.append(aweme_id)
                
                print(f"  [API] Offset {offset}: got {len(items)} items, total: {len(all_video_ids)}")
                
                has_more = data.get("has_more", 0)
                if not has_more:
                    break
                
                offset += count
                random_sleep(2, 4)
            else:
                print(f"  [!] API returned status {resp.status_code}")
                break
                
        except Exception as e:
            print(f"  [!] API error: {e}")
            break
    
    video_id_list = all_video_ids[:TARGET_VIDEO_COUNT]
    print(f"[OK] API collected {len(video_id_list)} video IDs")
    return video_id_list


def get_video_comments_via_browser(driver, video_id, video_index):
    """通过浏览器获取单个视频的评论"""
    video_url = f"https://www.douyin.com/video/{video_id}"
    print(f"  [->] Video {video_index + 1}: {video_id}")
    
    for attempt in range(MAX_RETRIES):
        try:
            driver.get(video_url)
            random_sleep(4, 6)
            
            # 截图调试（仅第一个视频）
            if video_index == 0 and attempt == 0:
                screenshot_path = os.path.join(OUTPUT_DIR, "video_page.png")
                try:
                    driver.save_screenshot(screenshot_path)
                    print(f"    Screenshot saved: {screenshot_path}")
                except Exception:
                    pass
            
            # 滚动加载评论
            for _ in range(8):
                driver.execute_script("window.scrollBy(0, 400);")
                random_sleep(1.5, 2.5)
            
            # 从页面源码提取评论
            page_source = driver.page_source
            comments = extract_comments_from_source(page_source)
            
            # 如果源码方式没找到，尝试 DOM 方式
            if not comments:
                comments = extract_comments_from_dom(driver)
            
            if comments:
                print(f"    [OK] Got {len(comments)} comments")
                return comments[:COMMENTS_PER_VIDEO]
            else:
                print(f"    [!] No comments (attempt {attempt + 1}/{MAX_RETRIES})")
                if attempt < MAX_RETRIES - 1:
                    random_sleep(3, 5)
                    
        except Exception as e:
            print(f"    [!] Error: {e} (attempt {attempt + 1}/{MAX_RETRIES})")
            if attempt < MAX_RETRIES - 1:
                random_sleep(5, 8)
    
    return []


def extract_comments_from_source(page_source):
    """从页面源码中提取评论（通过 SSR 数据或 JSON）"""
    comments = []
    
    # 方法1: 从 RENDER_DATA 中提取
    try:
        render_match = re.search(r'<script\s+id="RENDER_DATA"\s+type="application/json">(.*?)</script>', page_source, re.DOTALL)
        if render_match:
            from urllib.parse import unquote
            render_data_str = unquote(render_match.group(1))
            render_data = json.loads(render_data_str)
            
            # 递归查找评论数据
            comment_list = find_comments_in_json(render_data)
            for c in comment_list:
                text = c.get("text", "") or c.get("content", "")
                user = c.get("user", {})
                username = user.get("nickname", "") if isinstance(user, dict) else ""
                if text:
                    comments.append({
                        "username": username or "anonymous",
                        "comment": text,
                    })
    except Exception:
        pass
    
    # 方法2: 从 __NEXT_DATA__ 或其他 script 标签提取
    if not comments:
        try:
            script_matches = re.findall(r'<script[^>]*>(.*?)</script>', page_source, re.DOTALL)
            for script_content in script_matches:
                if '"comments"' in script_content or '"comment_list"' in script_content:
                    # 尝试提取 JSON
                    json_matches = re.findall(r'\{[^{}]*"comments?"[^{}]*\}', script_content)
                    for jm in json_matches:
                        try:
                            data = json.loads(jm)
                            comment_list = data.get("comments", data.get("comment_list", []))
                            for c in comment_list:
                                text = c.get("text", "")
                                user = c.get("user", {})
                                username = user.get("nickname", "") if isinstance(user, dict) else ""
                                if text:
                                    comments.append({"username": username or "anonymous", "comment": text})
                        except Exception:
                            pass
        except Exception:
            pass
    
    # 去重
    seen = set()
    unique = []
    for c in comments:
        h = hashlib.md5(c["comment"].encode()).hexdigest()
        if h not in seen:
            seen.add(h)
            unique.append(c)
    
    return unique


def find_comments_in_json(data, depth=0):
    """递归查找 JSON 中的评论数据"""
    if depth > 15:
        return []
    
    results = []
    
    if isinstance(data, dict):
        # 直接检查是否有评论列表
        for key in ["comments", "comment_list", "commentData", "comment_list_data"]:
            if key in data and isinstance(data[key], list):
                results.extend(data[key])
        
        # 检查 aweme_id 相关的评论
        if "text" in data and "user" in data and isinstance(data.get("user"), dict):
            results.append(data)
        
        # 递归
        for v in data.values():
            results.extend(find_comments_in_json(v, depth + 1))
    
    elif isinstance(data, list):
        for item in data:
            results.extend(find_comments_in_json(item, depth + 1))
    
    return results


def extract_comments_from_dom(driver):
    """从 DOM 中提取评论"""
    comments = []
    
    # 尝试多种选择器
    selectors = [
        '[data-e2e="comment-list"] [data-e2e="comment-item"]',
        '[class*="commentItem"]',
        '[class*="comment-item"]',
        '[class*="CommentItem"]',
        '[class*="DyComment"] [class*="Item"]',
        '[class*="comment-list"] > div',
    ]
    
    for selector in selectors:
        try:
            elements = driver.find_elements(By.CSS_SELECTOR, selector)
            if elements:
                for elem in elements:
                    try:
                        text = elem.text.strip()
                        if text and len(text) > 1:
                            # 尝试分离用户名和评论
                            lines = [l.strip() for l in text.split('\n') if l.strip()]
                            username = lines[0] if lines else "anonymous"
                            comment = lines[-1] if len(lines) > 1 else text
                            if len(comment) > 1:
                                comments.append({
                                    "username": username,
                                    "comment": comment,
                                })
                    except Exception:
                        pass
                if comments:
                    break
        except Exception:
            continue
    
    # 去重
    seen = set()
    unique = []
    for c in comments:
        h = hashlib.md5(c["comment"].encode()).hexdigest()
        if h not in seen:
            seen.add(h)
            unique.append(c)
    
    return unique


def get_video_comments_via_api(driver, video_id, video_index):
    """通过 API 获取视频评论"""
    cookies = get_cookies_from_driver(driver)
    headers = get_common_headers(driver)
    
    comments = []
    cursor = 0
    count = 20
    
    try:
        api_url = "https://www.douyin.com/aweme/v1/web/comment/list/"
        params = {
            "aweme_id": video_id,
            "cursor": cursor,
            "count": count,
            "item_type": 0,
            "insert_ids": "",
            "whale_cut_token": "",
            "cut_version": 1,
            "rcFT": "",
            "cookie_enabled": "true",
            "platform": "PC",
            "device_platform": "webapp",
            "aid": "6383",
            "channel": "channel_pc_web",
        }
        
        resp = requests.get(api_url, params=params, cookies=cookies, headers=headers, timeout=15)
        
        if resp.status_code == 200:
            data = resp.json()
            comment_list = data.get("comments", [])
            
            for c in comment_list:
                text = c.get("text", "")
                user = c.get("user", {})
                username = user.get("nickname", "") if isinstance(user, dict) else ""
                if text:
                    comments.append({
                        "username": username or "anonymous",
                        "comment": text,
                    })
        else:
            print(f"    [!] Comment API status: {resp.status_code}")
            
    except Exception as e:
        print(f"    [!] Comment API error: {e}")
    
    return comments[:COMMENTS_PER_VIDEO]


def save_results(all_data, keyword):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    
    json_path = os.path.join(OUTPUT_DIR, f"douyin_comments_{keyword}_{timestamp}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(all_data, f, ensure_ascii=False, indent=2)
    print(f"\n[OK] JSON saved: {json_path}")
    
    csv_path = os.path.join(OUTPUT_DIR, f"douyin_comments_{keyword}_{timestamp}.csv")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["video_index", "video_id", "video_url", "username", "comment"])
        for item in all_data:
            for comment in item.get("comments", []):
                writer.writerow([
                    item["video_index"],
                    item["video_id"],
                    item["video_url"],
                    comment.get("username", ""),
                    comment.get("comment", "")
                ])
    print(f"[OK] CSV saved: {csv_path}")
    
    return json_path, csv_path


def main():
    all_data = []
    
    print("=" * 60)
    print(f"  Douyin Comment Scraper v2")
    print(f"  Keyword: {KEYWORD}")
    print(f"  Target videos: {TARGET_VIDEO_COUNT}")
    print(f"  Comments per video: {COMMENTS_PER_VIDEO}")
    print("=" * 60 + "\n")
    
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # 初始化浏览器
    print("[1/5] Starting browser...")
    driver = setup_driver()
    
    try:
        # 登录
        print("[2/5] Checking login status...")
        has_cookies = load_cookies(driver)
        if not has_cookies:
            wait_for_login(driver)
        else:
            driver.get("https://www.douyin.com")
            random_sleep(3, 5)
        
        # 搜索视频 - 先尝试浏览器方式，再尝试 API
        print(f"[3/5] Searching videos for '{KEYWORD}'...")
        
        # 方式1: 浏览器搜索
        video_ids = search_videos_via_browser(driver, KEYWORD)
        
        # 方式2: 如果浏览器方式失败，尝试 API
        if len(video_ids) < 10:
            print("[!] Browser search got few results, trying API...")
            api_ids = search_videos_via_api(driver, KEYWORD)
            # 合并去重
            all_ids = list(dict.fromkeys(video_ids + api_ids))
            video_ids = all_ids[:TARGET_VIDEO_COUNT]
        
        if not video_ids:
            print("[!] No videos found!")
            print("[!] Trying to debug page structure...")
            
            # 调试：打印页面信息
            print(f"  Current URL: {driver.current_url}")
            print(f"  Page title: {driver.title}")
            
            # 保存页面源码用于分析
            debug_path = os.path.join(OUTPUT_DIR, "debug_page.html")
            with open(debug_path, "w", encoding="utf-8") as f:
                f.write(driver.page_source)
            print(f"  Page source saved: {debug_path}")
            
            return
        
        # 爬取评论
        print(f"\n[4/5] Scraping comments ({len(video_ids)} videos)...\n")
        total_comments = 0
        
        for i, vid in enumerate(video_ids):
            video_url = f"https://www.douyin.com/video/{vid}"
            
            # 先尝试 API 方式获取评论
            comments = get_video_comments_via_api(driver, vid, i)
            
            # 如果 API 失败，用浏览器方式
            if not comments:
                comments = get_video_comments_via_browser(driver, vid, i)
            
            total_comments += len(comments)
            
            all_data.append({
                "video_index": i + 1,
                "video_id": vid,
                "video_url": video_url,
                "comments_count": len(comments),
                "comments": comments
            })
            
            print(f"  [Progress] {i + 1}/{len(video_ids)} | This: {len(comments)} | Total: {total_comments}")
            
            # 每10个视频保存一次
            if (i + 1) % 10 == 0:
                save_results(all_data, KEYWORD)
                print(f"  [Save] Checkpoint saved")
            
            # 随机延迟
            random_sleep(2, 5)
            
            # 偶尔长暂停
            if random.random() < 0.1:
                pause = random.uniform(8, 15)
                print(f"  [Wait] Long pause {pause:.1f}s...")
                time.sleep(pause)
        
        # 保存最终结果
        print(f"\n[5/5] Saving final results...")
        json_path, csv_path = save_results(all_data, KEYWORD)
        
        print("\n" + "=" * 60)
        print(f"  Done!")
        print(f"  Videos: {len(all_data)}")
        print(f"  Comments: {total_comments}")
        print(f"  JSON: {json_path}")
        print(f"  CSV: {csv_path}")
        print("=" * 60)
        
    except KeyboardInterrupt:
        print("\n[!] Interrupted, saving collected data...")
        if all_data:
            save_results(all_data, KEYWORD)
    except Exception as e:
        print(f"\n[!] Error: {e}")
        import traceback
        traceback.print_exc()
        if all_data:
            save_results(all_data, KEYWORD)
    finally:
        try:
            driver.quit()
        except Exception:
            pass
        print("\n[OK] Browser closed")


if __name__ == "__main__":
    main()
