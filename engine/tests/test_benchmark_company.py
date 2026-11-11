from haludec.benchmark import build_agent_system_prompt


def test_company_name_is_configurable() -> None:
    prompt = build_agent_system_prompt({"doc": "Text."}, company="Acme Co")
    assert "customer support assistant for Acme Co." in prompt
    assert "Northwind" not in prompt


def test_default_company_keeps_the_original_prompt() -> None:
    assert "customer support assistant for Northwind Home Goods." in build_agent_system_prompt(
        {"doc": "Text."}
    )
