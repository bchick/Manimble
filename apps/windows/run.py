"""Start Manimble for Windows from a checkout:  .venv\\Scripts\\python.exe apps\\windows\\run.py [deck folder]"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from manimble_win.__main__ import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
