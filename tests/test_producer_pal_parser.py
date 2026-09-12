from phrase2photon.bridge.producer_pal import parse_ppal_result


def test_parse_ppal_object_literal() -> None:
    raw = '{name:"Demo",tempo:122,isPlaying:true,locators:[{id:"locator-0",name:"Intro",time:"9|1"},{id:"locator-1",name:2,time:"17|1"}]}'
    parsed = parse_ppal_result(raw)

    assert parsed["name"] == "Demo"
    assert parsed["tempo"] == 122
    assert parsed["isPlaying"] is True
    assert parsed["locators"][1]["name"] == 2


def test_parse_ppal_result_falls_back_to_plain_text() -> None:
    raw = "WARNING: quantize ignored for audio clip"
    parsed = parse_ppal_result(raw)

    assert parsed == raw
