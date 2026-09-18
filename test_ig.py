import sys
from instagrapi import Client
import json

def login(username, password):
    cl = Client()
    try:
        cl.login(username, password)
        print(json.dumps({"success": True}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    login(sys.argv[1], sys.argv[2])
