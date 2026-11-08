def summarize_memory(state):
    return {"total": len(state["history"]), "currentSolutionDigest": state["currentSolutionDigest"], "retrieval": {"tool": "experiment", "actions": ["search", "get", "compare"]}}
