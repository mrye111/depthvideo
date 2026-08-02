"""服务入口：python -m server（仅绑 127.0.0.1，端口可用 MOTION_PORT 覆盖）。"""
import os

import uvicorn


def main() -> None:
    port = int(os.environ.get('MOTION_PORT', '8788'))
    uvicorn.run('server.app:app', host='127.0.0.1', port=port, log_level='info')


if __name__ == '__main__':
    main()
