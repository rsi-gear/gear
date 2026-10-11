"""Public errors, with a stable code and a useful path for author mistakes."""

class GearAlgorithmError(Exception):
    def __init__(self, code: str, message: str, path: str = "$") -> None:
        self.code = code
        self.path = path
        super().__init__(f"{code} at {path}: {message}")


class ValidationError(GearAlgorithmError):
    def __init__(self, message: str, path: str = "$") -> None:
        super().__init__("VALIDATION", message, path)


class ProtocolError(GearAlgorithmError):
    def __init__(self, message: str, path: str = "$") -> None:
        super().__init__("PROTOCOL", message, path)
