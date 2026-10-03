"""Read language-model metadata from flat or composite HF configurations."""


def language_metadata(config):
    text = config.get("text_config", {})
    if not isinstance(text, dict):
        text = {}
    dtype = config.get("torch_dtype", config.get("dtype", text.get("torch_dtype", text.get("dtype"))))
    context = config.get("max_position_embeddings", text.get("max_position_embeddings"))
    return dtype, context
