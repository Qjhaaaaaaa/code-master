# Bing图片批量爬取脚本
# 用法: python bing_image_scraper.py "关键词" 数量 保存目录
# 示例: python bing_image_scraper.py "bikini beach" 100 "桌面路径/bikini_images"

import urllib.request
import urllib.parse
import ssl
import os
import re
import json
import sys
import time
import hashlib
from html import unescape

# 跳过SSL验证
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def search_bing_images(keyword, count=100):
    """从Bing搜索图片，返回图片URL列表"""
    image_urls = []
    page = 0
    per_page = 35  # Bing每页约35张

    while len(image_urls) < count:
        first = page * per_page + 1
        params = urllib.parse.urlencode({
            "q": keyword,
            "form": "HDRSC2",
            "first": first,
            "count": per_page,
        })
        url = f"https://www.bing.com/images/search?{params}"

        try:
            req = urllib.request.Request(url, headers=HEADERS)
            resp = urllib.request.urlopen(req, timeout=20, context=ctx)
            html = resp.read().decode("utf-8", errors="ignore")

            # 方法1: 从 murl 字段提取原始图片URL
            murls = re.findall(r'"murl"\s*:\s*"(https?://[^"]+)"', html)
            for u in murls:
                u = u.replace("\\u0026", "&").replace("\\/", "/")
                if u not in image_urls and len(image_urls) < count:
                    image_urls.append(u)

            # 方法2: 从 img src 提取
            if len(image_urls) < count:
                img_srcs = re.findall(r'<img[^>]+src="(https?://[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"', html, re.IGNORECASE)
                for u in img_srcs:
                    if u not in image_urls and "bing.com" not in u and len(image_urls) < count:
                        image_urls.append(u)

            print(f"  第{page+1}页搜索完成，已收集 {len(image_urls)} 个图片URL")

        except Exception as e:
            print(f"  第{page+1}页搜索失败: {e}")

        page += 1
        if page > 10:  # 最多搜10页
            break
        time.sleep(1)

    return image_urls[:count]


def download_image(url, save_path, timeout=15):
    """下载单张图片"""
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        data = urllib.request.urlopen(req, timeout=timeout, context=ctx).read()

        # 检查是否是有效图片（至少5KB）
        if len(data) < 5000:
            return False, "文件太小，可能不是有效图片"

        with open(save_path, "wb") as f:
            f.write(data)
        return True, len(data)

    except Exception as e:
        return False, str(e)


def main():
    # 默认参数
    keyword = "bikini beach beautiful"
    target_count = 100
    save_dir = os.path.join(os.path.expanduser("~"), "Desktop", "bikini_images")

    # 从命令行参数读取
    if len(sys.argv) >= 2:
        keyword = sys.argv[1]
    if len(sys.argv) >= 3:
        target_count = int(sys.argv[2])
    if len(sys.argv) >= 4:
        save_dir = sys.argv[3]

    # 创建保存目录
    os.makedirs(save_dir, exist_ok=True)

    print(f"=" * 50)
    print(f"关键词: {keyword}")
    print(f"目标数量: {target_count}")
    print(f"保存目录: {save_dir}")
    print(f"=" * 50)

    # 搜索图片URL
    print(f"\n[1/2] 搜索图片URL...")
    urls = search_bing_images(keyword, target_count * 2)  # 多搜一些，下载可能失败
    print(f"共找到 {len(urls)} 个图片URL\n")

    if not urls:
        print("未找到任何图片URL，请检查网络或关键词")
        return

    # 下载图片
    print(f"[2/2] 开始下载图片...")
    success_count = 0
    fail_count = 0

    for i, url in enumerate(urls):
        if success_count >= target_count:
            break

        # 生成文件名
        ext = ".jpg"
        if ".png" in url.lower():
            ext = ".png"
        elif ".webp" in url.lower():
            ext = ".webp"

        filename = f"img_{success_count + 1:03d}{ext}"
        save_path = os.path.join(save_dir, filename)

        ok, info = download_image(url, save_path)
        if ok:
            success_count += 1
            print(f"  ✅ [{success_count}/{target_count}] {filename} ({info} bytes)")
        else:
            fail_count += 1
            # 删除可能的空文件
            if os.path.exists(save_path):
                os.remove(save_path)
            if fail_count <= 5:
                print(f"  ❌ 失败: {info[:60]}")

        time.sleep(0.3)  # 避免请求太快

    print(f"\n{'=' * 50}")
    print(f"下载完成!")
    print(f"  成功: {success_count} 张")
    print(f"  失败: {fail_count} 张")
    print(f"  保存目录: {save_dir}")
    print(f"{'=' * 50}")


if __name__ == "__main__":
    main()
