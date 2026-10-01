"""Narrow transport using the existing Coinbase SDK. No credentials on stdout/argv.

Each invocation performs only the named operation. No application imports from
the existing trader, no account transfers, no scheduler or server mutations.
"""
import json
import os
import sys


def plain(value):
    return value.to_dict() if hasattr(value, 'to_dict') else value


def make_client():
    from coinbase.rest import RESTClient
    # Precedence: inline/env key pair first, then the CDP JSON key file. The
    # node side never overwrites an environment variable with config, so a
    # secret can be supplied entirely through the environment.
    name = os.environ.get('COINBASE_KEY_NAME')
    secret = os.environ.get('COINBASE_KEY_SECRET')
    if name and secret:
        return RESTClient(api_key=name, api_secret=secret, timeout=18)
    path = os.environ.get('COINBASE_KEY_FILE')
    if not path:
        raise RuntimeError('No Coinbase credential configured')
    with open(path) as f:
        key = json.load(f)
    return RESTClient(api_key=key['name'], api_secret=key['privateKey'], timeout=18)


def run(request, client=None):
    client = client or make_client()
    portfolio = os.environ.get('COINBASE_PORTFOLIO', '')
    action, args = request['action'], request.get('args', {})
    if action == 'products':
        return plain(client.get_products(product_type='SPOT', limit=1000, offset=int(args.get('offset', 0)), get_tradability_status=True))
    if action == 'product':
        return plain(client.get_product(product_id=args['product_id']))
    if action == 'candles':
        return plain(client.get_candles(**args, limit=350))
    if action == 'trades':
        return plain(client.get_market_trades(**args, limit=1000))
    if action == 'book':
        return plain(client.get_product_book(product_id=args['product_id'], limit=50))
    if action == 'fees':
        return plain(client.get_transaction_summary())
    if action == 'accounts':
        accounts, cursor = [], None
        for _ in range(100):
            result = plain(client.get_accounts(limit=250, **({'cursor': cursor} if cursor else {})))
            accounts.extend(a for a in result.get('accounts', []) if not portfolio or a.get('retail_portfolio_id') == portfolio)
            if not result.get('has_next'):
                return {'accounts': accounts}
            cursor = result.get('cursor')
            if not cursor:
                raise ValueError('Missing account cursor')
        raise ValueError('Account pagination exhausted')
    if action == 'order':
        return plain(client.get_order(order_id=args['order_id']))
    if action == 'find':
        cursor = None
        for _ in range(100):
            result = plain(client.list_orders(start_date=args['start_date'], limit=100, **({'cursor': cursor} if cursor else {})))
            for order in result.get('orders', []):
                if order.get('client_order_id') == args['client_id']:
                    return {'order': order}
            if not result.get('has_next'):
                return {'order': None}
            cursor = result.get('cursor')
            if not cursor:
                raise ValueError('Missing orders cursor')
        raise ValueError('Order pagination exhausted')
    if action == 'create':
        if os.environ.get('COINBASE_LIVE') != '1':
            raise PermissionError('Real order submission disabled')
        if args['side'] not in ('BUY', 'SELL') or not args['product_id'].endswith('-USDC'):
            raise ValueError('Invalid spot order')
        size_key = 'quote_size' if args['side'] == 'BUY' else 'base_size'
        if not portfolio:
            raise ValueError('Explicit portfolio required')
        return plain(client.create_order(client_order_id=args['client_order_id'], product_id=args['product_id'], side=args['side'], retail_portfolio_id=portfolio, order_configuration={'market_market_ioc': {size_key: args['size']}}))
    raise ValueError('Unsupported Coinbase operation')


if __name__ == '__main__':
    try:
        data = run(json.load(sys.stdin))
        print(json.dumps({'ok': True, 'data': data}))
    except Exception:
        # Do not leak credentials, request headers, private response bodies.
        print(json.dumps({'ok': False, 'error': 'Coinbase operation failed'}))
        sys.exit(1)
