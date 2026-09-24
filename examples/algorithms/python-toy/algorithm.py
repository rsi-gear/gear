from gear_algorithm import AlgorithmManifest, advance, task

@task("echo", kind="toy.echo")
def echo(value):
    return {"value": value}

class Toy:
    def describe(self):
        return AlgorithmManifest(id="python-toy", stateSchema={"type":"object"}, configSchema={"type":"object"}, bindingSchema={"id":"toy-bindings","slots":{}})
    def initialize(self, context):
        return advance({"step":"echo"}, echo("hello"))
    def reduce(self, context):
        return advance({"step":"done","reply":context["completed"]["echo"]}, complete=True)

algorithm = Toy()
