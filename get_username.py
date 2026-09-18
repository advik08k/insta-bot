import sys
import json
from instagrapi import Client

def get_username(sessionid):
    try:
        cl = Client()
        cl.login_by_sessionid(sessionid)
        info = cl.account_info()
        print(json.dumps({"success": True, "username": info.username}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Missing sessionid"}))
        sys.exit(1)
        
    get_username(sys.argv[1])
