import sys
import json
from instagrapi import Client
import os

def upload_reel(sessionid, video_path, thumbnail_path, caption):
    try:
        cl = Client()
        cl.login_by_sessionid(sessionid)
        
        # Upload the video as a Reel (Clip)
        media = cl.clip_upload(path=video_path, caption=caption, thumbnail=thumbnail_path)
        
        print(json.dumps({"success": True, "media_code": media.code}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    # Ensure correct encoding for Windows
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) < 5:
        print(json.dumps({"success": False, "error": "Missing arguments"}))
        sys.exit(1)
        
    upload_reel(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
