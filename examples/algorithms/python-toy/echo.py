from gear_algorithm import DurableLocalProvider, ProviderManifest

class Echo(DurableLocalProvider):
    def __init__(self):
        super().__init__(ProviderManifest("toy.echo", {"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":False}, {"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":False}))
    def execute(self, request):
        return {"kind":"result","value":request["input"]}

provider = Echo()
