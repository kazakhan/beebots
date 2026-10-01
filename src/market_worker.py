"""Persistent, read-only market transport. Reuses the SDK's HTTP session.

Cannot submit, cancel, transfer, or query private portfolio state.
"""
import json
import os
import sys
from coinbase_bridge import make_client, run

os.environ['COINBASE_LIVE'] = '0'
client = make_client()
for line in sys.stdin:
    try:
        request = json.loads(line)
        if request.get('action') not in {'products', 'product', 'candles', 'book', 'trades'}:
            raise PermissionError('Read-only market worker')
        result = {'ok': True, 'data': run(request, client)}
    except Exception as exc:
        status = getattr(getattr(exc, 'response', None), 'status_code', None)
        result = {'ok': False, 'error': type(exc).__name__, 'status': status}
    print(json.dumps(result), flush=True)
