"""CPU checks for live Vast routes, including the observed dual-stack mapping."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('vast_connection', Path(__file__).resolve().parents[1] / 'probes/vast_connection.py')
connection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connection)


class VastConnectionTests(unittest.TestCase):
    def setUp(self):
        self.instance = {'ssh_host': 'ssh3.vast.ai', 'ssh_port': 36638,
                         'public_ipaddr': '60.53.150.159', 'ports': None,
                         'image_runtype': 'ssh_direc ssh_proxy'}

    def test_stopped_instance_uses_proxy(self):
        self.assertEqual(connection.ssh_endpoint(self.instance)['port'], 36638)

    def test_new_observation_replaces_old_port(self):
        for port in (61127, 61128):
            self.instance['ports'] = {'22/tcp': [{'HostPort': str(port)}]}
            self.assertEqual(connection.ssh_endpoint(self.instance)['port'], port)

    def test_actual_dual_stack_mapping(self):
        self.instance['ports'] = {'22/tcp': [
            {'HostIp': '0.0.0.0', 'HostPort': '61127'},
            {'HostIp': '::', 'HostPort': '61127'}]}
        self.assertEqual(connection.ssh_endpoint(self.instance)['port'], 61127)

    def test_explicit_proxy_ignores_direct_mapping(self):
        self.instance['ports'] = {'22/tcp': [{'HostPort': '61127'}]}
        self.assertEqual(connection.ssh_endpoint(self.instance, prefer_proxy=True)['host'], 'ssh3.vast.ai')

    def test_conflicting_ports_are_rejected(self):
        self.instance['ports'] = {'22/tcp': [{'HostPort': '1'}, {'HostPort': '2'}]}
        with self.assertRaises(AssertionError):
            connection.ssh_endpoint(self.instance)

    def test_invalid_proxy_values_are_rejected(self):
        for field, value in [('ssh_host', 'host\nUser other'), ('ssh_port', True), ('ssh_port', 0)]:
            with self.subTest(field=field, value=value), self.assertRaises(AssertionError):
                connection.ssh_endpoint({**self.instance, field: value})


if __name__ == '__main__':
    unittest.main()
