import React from "react";
import Button from "./Button";

type CounterProps = { start: number };
type CounterState = { count: number };

export default class Counter extends React.Component<CounterProps, CounterState> {
  state: CounterState = { count: 0 };

  componentWillMount() {
    this.setState({ count: this.props.start });
  }

  componentWillReceiveProps(next: CounterProps) {
    if (next.start !== this.props.start) this.setState({ count: next.start });
  }

  render() {
    return (
      <div>
        <span>{this.state.count}</span>
        <Button label="+1" onClick={() => this.setState({ count: this.state.count + 1 })} />
      </div>
    );
  }
}
