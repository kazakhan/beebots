import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
import io
import runpy
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'src' / 'coinbase_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class Client:
    last = None
    instances = 0

    def __init__(self, **kwargs):
        Client.instances += 1

    def create_order(self, **kwargs):
        Client.last = kwargs
        return {'success': True}

    def get_accounts(self, **kwargs):
        return {'has_next': False, 'accounts': [
            {'retail_portfolio_id': 'ours', 'currency': 'USDC'},
            {'retail_portfolio_id': 'other', 'currency': 'USDC'}]}

    def get_products(self, **kwargs):
        Client.last=kwargs
        return {'products': []}

    def get_product_book(self, **kwargs):
        Client.last=kwargs
        return {'pricebook': {}}


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        key = Path(self.tmp.name) / 'fixture.json'
        key.write_text(json.dumps({'name': 'fixture-only', 'privateKey': 'fixture-only'}))
        self.env = patch.dict(os.environ, COINBASE_KEY_FILE=str(key), COINBASE_PORTFOLIO='ours', COINBASE_LIVE='0')
        self.env.start()
        self.modules = patch.dict(sys.modules, {'coinbase': types.ModuleType('coinbase'), 'coinbase.rest': types.SimpleNamespace(RESTClient=Client)})
        self.modules.start()
        Client.last = None

    def tearDown(self):
        self.modules.stop()
        self.env.stop()
        self.tmp.cleanup()

    def request(self, side='BUY'):
        return {'action': 'create', 'args': {'client_order_id': 'unchanged-id', 'product_id': 'BTC-USDC', 'side': side, 'size': '1.25'}}

    def test_observe_never_submits(self):
        with self.assertRaises(PermissionError):
            bridge.run(self.request())
        self.assertIsNone(Client.last)

    def test_buy_is_quote_sized_and_portfolio_bound(self):
        os.environ['COINBASE_LIVE'] = '1'
        bridge.run(self.request())
        self.assertEqual(Client.last['order_configuration'], {'market_market_ioc': {'quote_size': '1.25'}})
        self.assertEqual(Client.last['client_order_id'], 'unchanged-id')
        self.assertEqual(Client.last['retail_portfolio_id'], 'ours')

    def test_sell_is_base_sized(self):
        os.environ['COINBASE_LIVE'] = '1'
        bridge.run(self.request('SELL'))
        self.assertEqual(Client.last['order_configuration'], {'market_market_ioc': {'base_size': '1.25'}})

    def test_accounts_do_not_sum_other_portfolios(self):
        result = bridge.run({'action': 'accounts'})
        self.assertEqual(len(result['accounts']), 1)
        self.assertEqual(result['accounts'][0]['retail_portfolio_id'], 'ours')

    def test_catalogue_requests_account_tradability_and_offset(self):
        bridge.run({'action':'products','args':{'offset':1000}})
        self.assertEqual(Client.last,dict(product_type='SPOT',limit=1000,offset=1000,get_tradability_status=True))

    def test_book_has_depth_for_small_order_cost_checks(self):
        bridge.run({'action':'book','args':{'product_id':'DOGE-USDC'}})
        self.assertEqual(Client.last['limit'],50)

    def test_persistent_worker_reuses_client_and_rejects_order_actions(self):
        before=Client.instances
        requests='\n'.join(json.dumps(x) for x in [
            {'action':'products'}, {'action':'products','args':{'offset':1000}},
            {'action':'create','args':{}}])+'\n'
        output=io.StringIO()
        with patch.dict(sys.modules, {'coinbase_bridge':bridge}), patch.object(sys,'stdin',io.StringIO(requests)), patch.object(sys,'stdout',output):
            runpy.run_path(str(Path(__file__).parents[1]/'src'/'market_worker.py'),run_name='__main__')
        rows=[json.loads(s) for s in output.getvalue().splitlines()]
        self.assertEqual(Client.instances-before,1)
        self.assertEqual([r['ok'] for r in rows],[True,True,False])
        self.assertEqual(rows[-1]['error'],'PermissionError')


if __name__ == '__main__':
    unittest.main()
