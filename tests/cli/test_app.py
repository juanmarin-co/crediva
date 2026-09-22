import asyncio
import signal
from pathlib import Path

import pytest

from lending_interest_rates.cli.app import PullOptions, main, parser, run_pull


def test_help_lists_available_commands(capsys) -> None:
    with pytest.raises(SystemExit) as raised:
        main(["--help"])

    assert raised.value.code == 0
    output = capsys.readouterr().out
    assert "pull" in output
    assert "convert" not in output


def test_pull_accepts_the_raw_storage_path(tmp_path: Path) -> None:
    args = parser().parse_args(["pull", "--raw-path", str(tmp_path)])

    assert args.raw_path == tmp_path


async def test_pull_maps_signal_cancellation_to_an_exit_code(
    capsys, tmp_path: Path
) -> None:
    task = asyncio.create_task(
        run_pull(
            PullOptions(
                raw_path=tmp_path,
                api_root="http://127.0.0.1:1",
            )
        )
    )
    await asyncio.sleep(0)
    task.cancel(signal.SIGTERM)

    assert await task == 143
    assert "INTERRUPTED signal=SIGTERM" in capsys.readouterr().err
