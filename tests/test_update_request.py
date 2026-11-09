"""The page's update request names the client and the system layer version; the root updater
installs the system layer first (thinksmart-ubuntu-image/update/thinksmart-update)."""
import json

from thinksmart_client import update


def test_request_carries_both(tmp_path, monkeypatch):
    monkeypatch.setattr(update, 'REQUESTS', tmp_path)
    assert update.request('install', '0.2.0', '0.3.0')
    assert json.loads((tmp_path / 'install').read_text()) == {'action': 'install', 'version': '0.2.0',
                                                               'system': '0.3.0'}
    assert update.request('check')
    assert json.loads((tmp_path / 'check').read_text())['action'] == 'check'
