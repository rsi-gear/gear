"""Select SSH coordinates from a fresh Vast instance observation, without its URL cache."""
import re


def _port(value):
    assert type(value) is int or isinstance(value, str) and value.isdecimal(), 'invalid SSH port'
    value = int(value)
    assert 1 <= value <= 65535, 'SSH port outside valid range'
    return value


def ssh_endpoint(instance, *, prefer_proxy=False):
    ports = instance.get('ports') or {}
    assert isinstance(ports, dict)
    mappings = ports.get('22/tcp')
    if mappings and not prefer_proxy:
        assert isinstance(mappings, list), 'invalid port mappings'
        observed_ports = {_port(mapping['HostPort']) for mapping in mappings}
        # Docker reports IPv4 and IPv6 bindings separately for the same port.
        assert len(observed_ports) == 1, 'conflicting direct SSH ports'
        host = instance['public_ipaddr']
        port = observed_ports.pop()
        kind = 'observed-direct-mapping'
    else:
        host = instance['ssh_host']
        port = instance['ssh_port']
        assert 'jupyter' not in instance.get('image_runtype', ''), 'this diagnostic expects SSH mode'
        kind = 'observed-vast-proxy'
    assert isinstance(host, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]*', host)
    return {'host': host, 'port': _port(port), 'user': 'root', 'kind': kind}
