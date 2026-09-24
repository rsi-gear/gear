from gear_algorithm import component

@component(id="choose", input_schema={"type":"object","properties":{"options":{"type":"array","items":{"type":"string"}}},"required":["options"],"additionalProperties":False}, output_schema={"type":"object","properties":{"choice":{"type":"string"}},"required":["choice"],"additionalProperties":False}, scope="campaign")
def choose(value):
    return {"choice": value["options"][0]}
