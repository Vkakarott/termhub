import unittest
from api import LOAD_RETRY_MAX_S, MAX_TEXTS, MAX_CHARS, BadRequest, authorized, load_retry_delay, parse_request

class ParseRequest(unittest.TestCase):
    def test_accepts_a_list_of_texts(self):
        self.assertEqual(parse_request(b'{"texts": ["a", "b"]}'), ["a", "b"])
    def test_rejects_non_json_missing_or_empty(self):
        for body in (b"nope", b"{}", b'{"texts": []}', b'{"texts": "a"}', b'{"texts": [1]}'):
            with self.assertRaises(BadRequest):
                parse_request(body)
    def test_rejects_too_many_or_too_long(self):
        with self.assertRaises(BadRequest):
            parse_request(('{"texts": [%s]}' % ",".join(['"x"'] * (MAX_TEXTS + 1))).encode())
        with self.assertRaises(BadRequest):
            parse_request(('{"texts": ["%s"]}' % ("x" * (MAX_CHARS + 1))).encode())

class Authorized(unittest.TestCase):
    def test_needs_the_exact_bearer(self):
        self.assertTrue(authorized("Bearer s3cret", "s3cret"))
        self.assertFalse(authorized("Bearer nope", "s3cret"))
        self.assertFalse(authorized(None, "s3cret"))
    def test_empty_secret_refuses_everything(self):
        self.assertFalse(authorized("Bearer ", ""))

class LoadRetryDelay(unittest.TestCase):
    def test_doubles_from_thirty_seconds(self):
        self.assertEqual([load_retry_delay(n) for n in range(4)], [30, 60, 120, 240])
    def test_never_waits_longer_than_the_cap(self):
        self.assertEqual(load_retry_delay(50), LOAD_RETRY_MAX_S)
        self.assertEqual(LOAD_RETRY_MAX_S, 900)

if __name__ == "__main__":
    unittest.main()
